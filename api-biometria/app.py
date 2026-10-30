# FLUXOGRAMA: entrada (POST /v1/assinatura/validar com Bearer JWT + corpo JSON) -> validação (JWT HS256 com aud e exp, claims atendimento_id/email_informado, consentimento, série e hash) -> lógica (transação única com FOR UPDATE no atendimento e no paciente; compara hash; avalia; atualiza perfil só se aprovado; contador de tentativas no banco) -> saída (JSON sem score; registro_assinaturas ou assinatura_tentativas gravados no mesmo commit)
# Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
"""API isolada de validação da assinatura dinâmica.

Variáveis de ambiente (nunca no repositório):
  SUPABASE_JWT_SECRET   segredo HS256 do projeto (mesmo usado para assinar o JWT no n8n)
  DATABASE_URL          conexão Postgres do projeto (pooler de transação ou direta)
  ORIGENS_PERMITIDAS    origens CORS, separadas por vírgula (ex.: https://clinicacsiia.github.io)
  CONFIAR_X_FORWARDED_FOR  "1" somente atrás de um proxy que você controla
"""

from __future__ import annotations

import hmac
import logging
import os
import uuid
from typing import Annotated, Any

import jwt
import psycopg
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

import biometria as bio

log = logging.getLogger("assinatura")   # nunca registra série, features nem score


class Ponto(BaseModel):
    x: float
    y: float
    timestamp: float
    pressao: float = 0.0
    traco: int = Field(default=0, ge=0, lt=bio.MAX_TRACOS)


class CorpoValidacao(BaseModel):
    pontos: list[Ponto] = Field(min_length=bio.MIN_PONTOS, max_length=bio.MAX_PONTOS)
    hash_documento: str = Field(pattern=r"^[0-9a-f]{64}$")
    consentimento: bool
    user_agent: str | None = Field(default=None, max_length=500)


def _ler_jwt(authorization: str | None, segredo: str) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "token_ausente")
    try:
        claims = jwt.decode(
            authorization[7:].strip(),
            segredo,
            algorithms=["HS256"],
            audience="authenticated",
            options={"require": ["exp", "aud", "sub"]},
        )
    except jwt.PyJWTError as erro:
        raise HTTPException(401, "token_invalido") from erro
    atendimento = claims.get("atendimento_id")
    email = claims.get("email_informado")
    if not atendimento or not email:
        raise HTTPException(401, "token_invalido")
    try:
        uuid.UUID(str(atendimento))
    except ValueError as erro:
        raise HTTPException(401, "token_invalido") from erro
    return claims


def _ip_origem(request: Request, confiar_proxy: bool) -> str | None:
    if confiar_proxy:
        encaminhado = request.headers.get("x-forwarded-for", "")
        if encaminhado:
            return encaminhado.split(",")[0].strip()[:45]
    return request.client.host if request.client else None


def _processar(
    cur: psycopg.Cursor,
    atendimento_id: uuid.UUID,
    email: str,
    corpo: CorpoValidacao,
    pontos: list[dict[str, Any]],
    user_agent: str,
    ip: str | None,
) -> dict[str, Any]:
    # Trava o atendimento: duas requisições paralelas não contam a mesma tentativa duas vezes.
    cur.execute(
        """select id, paciente_id, status, documento_hash, tentativas_falhas, bloqueado_em
             from public.atendimentos where id = %s for update""",
        (atendimento_id,),
    )
    atendimento = cur.fetchone()
    if atendimento is None:
        raise HTTPException(401, "token_invalido")
    if atendimento["bloqueado_em"] is not None:
        raise HTTPException(423, "bloqueado")
    if atendimento["status"] != "assinatura_pendente":
        raise HTTPException(409, "fora_de_assinatura")
    if not hmac.compare_digest(atendimento["documento_hash"] or "", corpo.hash_documento):
        raise HTTPException(409, "documento_diferente")

    # Trava o perfil do paciente: o aprendizado não pode ser sobrescrito por outra transação.
    cur.execute(
        "select perfil_biometrico_historico from public.pacientes where id = %s for update",
        (atendimento["paciente_id"],),
    )
    paciente = cur.fetchone()
    perfil = paciente["perfil_biometrico_historico"] or bio.novo_perfil()

    caracteristicas = bio.extract_dynamic_features(pontos)
    avaliacao = bio.avaliar(caracteristicas, perfil)

    if not avaliacao.aprovado:
        resultado = bio.registrar_tentativa(atendimento["tentativas_falhas"], aprovado=False)
        cur.execute(
            """update public.atendimentos
                  set tentativas_falhas = %s,
                      bloqueado_em = case when %s then now() end,
                      atualizado_em = now()
                where id = %s""",
            (resultado.falhas, resultado.bloqueado, atendimento_id),
        )
        cur.execute(
            """insert into public.assinatura_tentativas
                 (atendimento_id, numero, score_similaridade, ip_origem, user_agent)
               values (%s, %s, %s, %s, %s)""",
            (atendimento_id, resultado.falhas, avaliacao.score, ip, user_agent),
        )
        log.info("assinatura reprovada atendimento=%s falhas=%s", atendimento_id, resultado.falhas)
        return {
            "aprovado": False,
            "tentativas_restantes": resultado.restantes,
            "bloqueado": resultado.bloqueado,
        }

    cur.execute(
        """update public.pacientes
              set perfil_biometrico_historico = %s, atualizado_em = now()
            where id = %s""",
        (Jsonb(bio.atualizar_perfil(perfil, caracteristicas)), atendimento["paciente_id"]),
    )
    cur.execute(
        """insert into public.registro_assinaturas
             (atendimento_id, email_confirmado_transacao, hash_documento, consentimento_biometrico,
              tipo_validacao, score_similaridade, vetor_traco_bruto, caracteristicas, ip_origem, user_agent)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (
            atendimento_id,
            email,
            corpo.hash_documento,
            corpo.consentimento,
            avaliacao.tipo,
            avaliacao.score,
            Jsonb(pontos),
            Jsonb(caracteristicas),
            ip,
            user_agent,
        ),
    )
    cur.execute(
        "update public.atendimentos set status = 'em_atendimento', atualizado_em = now() where id = %s",
        (atendimento_id,),
    )
    log.info("assinatura aprovada atendimento=%s tipo=%s", atendimento_id, avaliacao.tipo)
    return {"aprovado": True, "status": "em_atendimento"}


def criar_app() -> FastAPI:
    segredo = os.environ.get("SUPABASE_JWT_SECRET", "")
    url_banco = os.environ.get("DATABASE_URL", "")
    if not segredo or not url_banco:
        raise RuntimeError("Defina SUPABASE_JWT_SECRET e DATABASE_URL antes de iniciar a API.")
    origens = [o.strip() for o in os.environ.get("ORIGENS_PERMITIDAS", "").split(",") if o.strip()]
    confiar_proxy = os.environ.get("CONFIAR_X_FORWARDED_FOR", "0") == "1"

    app = FastAPI(
        title="Assinatura biométrica",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origens,
        allow_methods=["POST"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )

    @app.post("/v1/assinatura/validar")
    def validar_assinatura(
        corpo: CorpoValidacao,
        request: Request,
        authorization: Annotated[str | None, Header()] = None,
    ) -> dict[str, Any]:
        claims = _ler_jwt(authorization, segredo)
        if not corpo.consentimento:
            raise HTTPException(422, "consentimento_obrigatorio")
        try:
            pontos = bio.validar_serie([p.model_dump() for p in corpo.pontos])
        except bio.SerieInvalida as erro:
            # Série ruim não conta como tentativa: é erro do cliente, não reprovação da assinatura.
            raise HTTPException(422, f"serie_invalida: {erro}") from erro

        atendimento_id = uuid.UUID(str(claims["atendimento_id"]))
        email = str(claims["email_informado"]).strip().lower()
        user_agent = (request.headers.get("user-agent") or corpo.user_agent or "")[:500]
        ip = _ip_origem(request, confiar_proxy)

        try:
            with psycopg.connect(url_banco, prepare_threshold=None) as conexao:
                with conexao.transaction(), conexao.cursor(row_factory=dict_row) as cur:
                    return _processar(cur, atendimento_id, email, corpo, pontos, user_agent, ip)
        except psycopg.Error as erro:
            log.error("falha de banco na validação: %s", type(erro).__name__)
            raise HTTPException(503, "indisponivel") from erro

    return app


app = criar_app()
