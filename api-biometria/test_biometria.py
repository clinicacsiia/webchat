# FLUXOGRAMA: entrada (séries sintéticas e cursor falso) -> validação (asserts sobre features, score, limiar, contador de tentativas, SQL emitido) -> lógica (cenários: enrolamento, mesma assinatura, assinatura diferente, hash trocado, terceira falha, JWT inválido) -> saída (pytest verde ou falha com causa)
# Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
"""Testes da validação biométrica. Rodar em api-biometria/: python -m pytest -q"""

from __future__ import annotations

import hashlib
import math
import os
import time

import jwt
import pytest
from fastapi.testclient import TestClient

SEGREDO_TESTE = "segredo-de-teste-com-mais-de-32-caracteres-xx"
os.environ.setdefault("SUPABASE_JWT_SECRET", SEGREDO_TESTE)
os.environ.setdefault("DATABASE_URL", "postgresql://invalido:invalido@127.0.0.1:1/invalido")
os.environ.setdefault("ORIGENS_PERMITIDAS", "https://clinicacsiia.github.io")

import app as modulo_app  # noqa: E402
import biometria as bio  # noqa: E402

HASH_DOC = hashlib.sha256("Autorizo o tratamento conforme o termo.".encode("utf-8")).hexdigest()


def serie_base(fase: float = 0.0, escala: float = 1.0, tracos: int = 2, pontos_por_traco: int = 30,
                intervalo_ms: float = 16.0, pressao: float = 0.6) -> list[dict]:
    pontos: list[dict] = []
    t = 0.0
    for k in range(tracos):
        for i in range(pontos_por_traco):
            u = i / (pontos_por_traco - 1)
            pontos.append({
                "x": 0.1 + 0.8 * u,
                "y": 0.5 + escala * 0.2 * math.sin(6.0 * u + fase + k),
                "timestamp": t,
                "pressao": pressao,
                "traco": k,
            })
            t += intervalo_ms
        t += 400.0
    return pontos


def perfil_de(pontos: list[dict]) -> dict:
    features = bio.extract_dynamic_features(pontos)
    return bio.atualizar_perfil(bio.novo_perfil(), features)


class CursorFalso:
    """Imita psycopg: devolve as linhas pedidas em ordem e guarda o SQL emitido."""

    def __init__(self, linhas: list[dict | None]):
        self.linhas = list(linhas)
        self.emitidos: list[tuple[str, tuple | None]] = []

    def execute(self, sql, params=None):
        self.emitidos.append((sql, params))

    def fetchone(self):
        return self.linhas.pop(0)


def atendimento(**sobrescrever) -> dict:
    base = {
        "id": "00000000-0000-4000-8000-000000000001",
        "paciente_id": "00000000-0000-4000-8000-0000000000aa",
        "status": "assinatura_pendente",
        "documento_hash": HASH_DOC,
        "tentativas_falhas": 0,
        "bloqueado_em": None,
    }
    base.update(sobrescrever)
    return base


# ---------- extração de características ----------

def test_extract_features_valores_conhecidos():
    pontos = serie_base(tracos=2, pontos_por_traco=30, intervalo_ms=16.0, pressao=0.6)
    f = bio.extract_dynamic_features(pontos)
    assert set(f) == set(bio.NOMES_FEATURES)
    assert f["num_tracos"] == 2.0
    assert f["duracao_ms"] == pytest.approx(pontos[-1]["timestamp"] - pontos[0]["timestamp"], abs=1e-3)
    assert f["pausa_media_ms"] == pytest.approx(416.0, abs=1e-3)
    assert f["pressao_media"] == pytest.approx(0.6, abs=1e-6)
    assert f["pressao_desvio"] == pytest.approx(0.0, abs=1e-6)
    assert f["velocidade_media"] > 0
    assert all(math.isfinite(v) for v in f.values())


def test_extract_features_e_deterministico():
    pontos = serie_base(fase=1.2)
    assert bio.extract_dynamic_features(pontos) == bio.extract_dynamic_features(list(pontos))


# ---------- validação da série (não conta como tentativa) ----------

def test_validar_serie_aceita_serie_valida():
    assert len(bio.validar_serie(serie_base())) == 60


def test_validar_serie_rejeita_serie_curta_demais():
    with pytest.raises(bio.SerieInvalida, match="entre"):
        bio.validar_serie(serie_base()[:5])


def test_validar_serie_rejeita_tempo_fora_de_ordem():
    pontos = serie_base()
    pontos[10]["timestamp"] = pontos[9]["timestamp"] - 5
    with pytest.raises(bio.SerieInvalida, match="fora de ordem"):
        bio.validar_serie(pontos)


def test_validar_serie_rejeita_valor_nao_finito():
    pontos = serie_base()
    pontos[3]["x"] = float("nan")
    with pytest.raises(bio.SerieInvalida, match="não finito"):
        bio.validar_serie(pontos)


def test_validar_serie_rejeita_duracao_curta():
    pontos = serie_base(pontos_por_traco=25, intervalo_ms=2.0, tracos=1)
    with pytest.raises(bio.SerieInvalida, match="duração"):
        bio.validar_serie(pontos)


def test_validar_serie_clampa_pequena_saida_do_canvas():
    pontos = serie_base()
    pontos[0]["x"] = -0.03
    limpos = bio.validar_serie(pontos)
    assert limpos[0]["x"] == 0.0


# ---------- enrolamento, comparação e aprendizado ----------

def test_enrolamento_aprova_sem_score():
    avaliacao = bio.avaliar(bio.extract_dynamic_features(serie_base()), bio.novo_perfil())
    assert avaliacao.tipo == "enrolamento"
    assert avaliacao.score is None
    assert avaliacao.aprovado is True


def test_mesma_assinatura_depois_do_enrolamento_tem_score_maximo():
    pontos = serie_base(fase=0.7)
    perfil = perfil_de(pontos)
    avaliacao = bio.avaliar(bio.extract_dynamic_features(pontos), perfil)
    assert avaliacao.tipo == "comparacao"
    assert avaliacao.score == pytest.approx(1.0, abs=1e-4)
    assert avaliacao.aprovado is True


def test_assinatura_muito_diferente_e_reprovada():
    perfil = perfil_de(serie_base(fase=0.0, escala=1.0, tracos=2, pontos_por_traco=30, intervalo_ms=16.0))
    diferente = serie_base(fase=2.5, escala=2.0, tracos=1, pontos_por_traco=40, intervalo_ms=60.0)
    avaliacao = bio.avaliar(bio.extract_dynamic_features(diferente), perfil)
    assert avaliacao.score is not None
    assert avaliacao.score < bio.SCORE_MINIMO
    assert avaliacao.aprovado is False


def test_limiar_030_equivale_a_distancia_de_7_tercos():
    assert bio.score_similaridade(7 / 3) == pytest.approx(0.30, abs=1e-9)


def test_atualizar_perfil_aprende_sem_pular_para_o_novo_valor():
    perfil = perfil_de(serie_base(intervalo_ms=16.0))
    antes = perfil["features"]["duracao_ms"]["media"]
    novo = bio.extract_dynamic_features(serie_base(intervalo_ms=30.0))
    atualizado = bio.atualizar_perfil(perfil, novo)
    assert atualizado["n"] == 2
    depois = atualizado["features"]["duracao_ms"]["media"]
    assert min(antes, novo["duracao_ms"]) < depois < max(antes, novo["duracao_ms"])


# ---------- controle de 3 tentativas ----------

def test_tres_falhas_bloqueiam_e_sucesso_nao_zera_contagem():
    r1 = bio.registrar_tentativa(0, aprovado=False)
    assert (r1.falhas, r1.restantes, r1.bloqueado) == (1, 2, False)
    r2 = bio.registrar_tentativa(r1.falhas, aprovado=False)
    assert (r2.falhas, r2.restantes, r2.bloqueado) == (2, 1, False)
    r3 = bio.registrar_tentativa(r2.falhas, aprovado=False)
    assert (r3.falhas, r3.restantes, r3.bloqueado) == (3, 0, True)


def test_aprovacao_mantem_o_contador():
    r = bio.registrar_tentativa(2, aprovado=True)
    assert (r.falhas, r.bloqueado) == (2, False)


# ---------- fluxo de banco com cursor falso ----------

def test_terceira_falha_grava_bloqueio_e_nao_devolve_score():
    perfil = perfil_de(serie_base(fase=0.0))
    cursor = CursorFalso([
        atendimento(tentativas_falhas=2),
        {"perfil_biometrico_historico": perfil},
    ])
    corpo = modulo_app.CorpoValidacao(
        pontos=[modulo_app.Ponto(**p) for p in serie_base(fase=2.5, escala=2.0, tracos=1, pontos_por_traco=40, intervalo_ms=60.0)],
        hash_documento=HASH_DOC,
        consentimento=True,
    )
    pontos = bio.validar_serie([p.model_dump() for p in corpo.pontos])
    resposta = modulo_app._processar(cursor, modulo_app.uuid.UUID(atendimento()["id"]), "paciente@exemplo.com", corpo, pontos, "ua-teste", "10.0.0.1")
    assert resposta == {"aprovado": False, "tentativas_restantes": 0, "bloqueado": True}
    assert "score" not in str(resposta)
    sql_update = [sql for sql, _ in cursor.emitidos if "update public.atendimentos" in sql and "bloqueado_em" in sql]
    assert sql_update, "a terceira falha precisa gravar bloqueado_em"
    assert not any("registro_assinaturas" in sql for sql, _ in cursor.emitidos)


def test_hash_diferente_do_documento_e_rejeitado_sem_gravar():
    cursor = CursorFalso([atendimento()])
    corpo = modulo_app.CorpoValidacao(
        pontos=[modulo_app.Ponto(**p) for p in serie_base()],
        hash_documento="f" * 64,
        consentimento=True,
    )
    pontos = bio.validar_serie([p.model_dump() for p in corpo.pontos])
    with pytest.raises(modulo_app.HTTPException) as erro:
        modulo_app._processar(cursor, modulo_app.uuid.UUID(atendimento()["id"]), "a@b.com", corpo, pontos, "ua", None)
    assert erro.value.status_code == 409
    assert len(cursor.emitidos) == 1  # só a leitura com trava


def test_aprovacao_grava_lastro_com_email_do_token_e_muda_status():
    pontos = serie_base(fase=0.7)
    perfil = perfil_de(pontos)
    cursor = CursorFalso([atendimento(), {"perfil_biometrico_historico": perfil}])
    corpo = modulo_app.CorpoValidacao(
        pontos=[modulo_app.Ponto(**p) for p in pontos],
        hash_documento=HASH_DOC,
        consentimento=True,
    )
    validados = bio.validar_serie([p.model_dump() for p in corpo.pontos])
    resposta = modulo_app._processar(cursor, modulo_app.uuid.UUID(atendimento()["id"]), "paciente@exemplo.com", corpo, validados, "ua", "10.0.0.1")
    assert resposta == {"aprovado": True, "status": "em_atendimento"}
    insercao = [params for sql, params in cursor.emitidos if "insert into public.registro_assinaturas" in sql]
    assert len(insercao) == 1
    assert insercao[0][1] == "paciente@exemplo.com"
    assert any("set status = 'em_atendimento'" in sql for sql, _ in cursor.emitidos)


# ---------- borda HTTP: autenticação e corpo ----------

@pytest.fixture()
def cliente():
    return TestClient(modulo_app.app)


def _token(**sobrescrever) -> str:
    agora = int(time.time())
    payload = {
        "role": "authenticated",
        "aud": "authenticated",
        "sub": "00000000-0000-4000-8000-0000000000aa",
        "atendimento_id": "00000000-0000-4000-8000-000000000001",
        "email_informado": "paciente@exemplo.com",
        "iat": agora,
        "exp": agora + 4 * 3600,
    }
    payload.update(sobrescrever)
    return jwt.encode(payload, SEGREDO_TESTE, algorithm="HS256")


def _corpo(consentimento: bool = True) -> dict:
    return {"pontos": serie_base(), "hash_documento": HASH_DOC, "consentimento": consentimento}


def test_sem_token_retorna_401(cliente):
    assert cliente.post("/v1/assinatura/validar", json=_corpo()).status_code == 401


def test_token_assinado_com_outro_segredo_retorna_401(cliente):
    falso = jwt.encode({"atendimento_id": "x", "email_informado": "a@b.com", "aud": "authenticated", "sub": "s", "exp": int(time.time()) + 60}, "outro-segredo-qualquer-com-32-chars-ok", algorithm="HS256")
    resposta = cliente.post("/v1/assinatura/validar", json=_corpo(), headers={"Authorization": f"Bearer {falso}"})
    assert resposta.status_code == 401


def test_token_expirado_retorna_401(cliente):
    resposta = cliente.post("/v1/assinatura/validar", json=_corpo(), headers={"Authorization": f"Bearer {_token(exp=int(time.time()) - 5)}"})
    assert resposta.status_code == 401


def test_sem_consentimento_retorna_422(cliente):
    resposta = cliente.post("/v1/assinatura/validar", json=_corpo(consentimento=False), headers={"Authorization": f"Bearer {_token()}"})
    assert resposta.status_code == 422
    assert resposta.json()["detail"] == "consentimento_obrigatorio"
