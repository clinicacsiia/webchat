# FLUXOGRAMA: entrada (pontos [{x, y, timestamp, pressao, traco}]) -> validação (tamanho, valores finitos, tempo crescente, duração, coordenadas normalizadas) -> lógica (features dinâmicas -> distância normalizada contra o perfil -> score = 1/(1+d) -> limiar 0.30 -> atualização EWMA do perfil só se aprovado; contador de 3 tentativas) -> saída (features, avaliação, perfil novo, resultado da tentativa)
# Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
"""Validação biométrica da assinatura dinâmica.

Funções puras: sem banco, sem HTTP, sem estado global. A transação e a trava de linha ficam em app.py.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

SCORE_MINIMO = 0.30
TENTATIVAS_MAXIMAS = 3
MIN_PONTOS = 20
MAX_PONTOS = 5000
DURACAO_MIN_MS = 300.0
DURACAO_MAX_MS = 60_000.0
MAX_TRACOS = 200
TOLERANCIA_BORDA = 0.05          # o pointer capture pode levar o ponteiro levemente para fora do canvas
JANELA_APRENDIZADO = 20          # taxa de aprendizado mínima = 1/20 (o perfil segue o paciente sem derivar sozinho)
PISO_DESVIO_RELATIVO = 0.10      # desvio nunca menor que 10% da média do próprio paciente

# Piso absoluto do desvio por feature. Evita que uma feature de média zero (ex.: pausa sem traços separados)
# transforme qualquer variação pequena em rejeição. Valores em unidades normalizadas (x, y em [0, 1]) e ms.
NOMES_FEATURES = (
    "velocidade_media",
    "jitter",
    "duracao_ms",
    "pressao_media",
    "pressao_desvio",
    "num_tracos",
    "pausa_media_ms",
)
PISO_DESVIO_ABSOLUTO = {
    "velocidade_media": 0.0005,
    "jitter": 0.001,
    "duracao_ms": 50.0,
    "pressao_media": 0.05,
    "pressao_desvio": 0.02,
    "num_tracos": 1.0,
    "pausa_media_ms": 300.0,
}


class SerieInvalida(ValueError):
    """Série recusada antes da comparação. Não conta como tentativa de assinatura."""


@dataclass(frozen=True)
class Avaliacao:
    tipo: str                    # "enrolamento" (primeira assinatura, sem perfil) ou "comparacao"
    score: float | None          # None no enrolamento
    aprovado: bool


@dataclass(frozen=True)
class ResultadoTentativa:
    falhas: int
    restantes: int
    bloqueado: bool


def validar_serie(pontos: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Confere e normaliza a série. Lança SerieInvalida com a causa; devolve cópia limpa."""
    if not MIN_PONTOS <= len(pontos) <= MAX_PONTOS:
        raise SerieInvalida(f"a série precisa ter entre {MIN_PONTOS} e {MAX_PONTOS} pontos")

    limpos: list[dict[str, Any]] = []
    tempo_anterior: float | None = None
    for indice, ponto in enumerate(pontos):
        try:
            x = float(ponto["x"])
            y = float(ponto["y"])
            t = float(ponto["timestamp"])
            pressao = float(ponto.get("pressao", 0.0))
            traco = int(ponto.get("traco", 0))
        except (KeyError, TypeError, ValueError) as erro:
            raise SerieInvalida(f"ponto {indice} malformado") from erro

        if not all(math.isfinite(v) for v in (x, y, t, pressao)):
            raise SerieInvalida(f"ponto {indice} com valor não finito")
        if tempo_anterior is not None and t < tempo_anterior:
            raise SerieInvalida(f"ponto {indice} fora de ordem no tempo")
        tempo_anterior = t
        if not (-TOLERANCIA_BORDA <= x <= 1 + TOLERANCIA_BORDA and -TOLERANCIA_BORDA <= y <= 1 + TOLERANCIA_BORDA):
            raise SerieInvalida(f"ponto {indice} fora do canvas normalizado")
        if not 0 <= traco < MAX_TRACOS:
            raise SerieInvalida(f"ponto {indice} com índice de traço inválido")

        limpos.append({
            "x": min(max(x, 0.0), 1.0),
            "y": min(max(y, 0.0), 1.0),
            "timestamp": t,
            "pressao": min(max(pressao, 0.0), 1.0),
            "traco": traco,
        })

    duracao = limpos[-1]["timestamp"] - limpos[0]["timestamp"]
    if not DURACAO_MIN_MS <= duracao <= DURACAO_MAX_MS:
        raise SerieInvalida("duração da assinatura fora do intervalo aceito")
    return limpos


def extract_dynamic_features(pontos: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Extrai as 7 características dinâmicas. Valida a série antes."""
    serie = validar_serie(pontos)

    tracos: dict[int, list[dict[str, Any]]] = {}
    for ponto in serie:
        tracos.setdefault(ponto["traco"], []).append(ponto)
    sequencias = [tracos[k] for k in sorted(tracos)]

    velocidades: list[float] = []
    jitters: list[float] = []
    for seq in sequencias:
        for a, b in zip(seq, seq[1:]):
            dt = b["timestamp"] - a["timestamp"]
            if dt > 0:
                velocidades.append(math.hypot(b["x"] - a["x"], b["y"] - a["y"]) / dt)
        for a, b, c in zip(seq, seq[1:], seq[2:]):
            # segunda diferença: quanto o traço "treme" entre amostras consecutivas
            jitters.append(math.hypot(c["x"] - 2 * b["x"] + a["x"], c["y"] - 2 * b["y"] + a["y"]))

    pausas = [
        proximo[0]["timestamp"] - anterior[-1]["timestamp"]
        for anterior, proximo in zip(sequencias, sequencias[1:])
    ]

    pressoes = [p["pressao"] for p in serie if p["pressao"] > 0]
    media_pressao = sum(pressoes) / len(pressoes) if pressoes else 0.0
    desvio_pressao = (
        math.sqrt(sum((p - media_pressao) ** 2 for p in pressoes) / len(pressoes)) if pressoes else 0.0
    )

    def media(valores: list[float]) -> float:
        return sum(valores) / len(valores) if valores else 0.0

    return {
        "velocidade_media": round(media(velocidades), 8),
        "jitter": round(media(jitters), 8),
        "duracao_ms": round(serie[-1]["timestamp"] - serie[0]["timestamp"], 3),
        "pressao_media": round(media_pressao, 6),
        "pressao_desvio": round(desvio_pressao, 6),
        "num_tracos": float(len(sequencias)),
        "pausa_media_ms": round(media(pausas), 3),
    }


def novo_perfil() -> dict[str, Any]:
    return {
        "versao": 1,
        "n": 0,
        "features": {nome: {"media": 0.0, "variancia": 0.0} for nome in NOMES_FEATURES},
    }


def distancia_normalizada(features: Mapping[str, float], perfil: Mapping[str, Any]) -> float:
    """Distância euclidiana média quadrática sobre z-scores contra o perfil do próprio paciente.

    d = sqrt( mean_i ( (f_i - mu_i) / sigma_i )^2 ). d = 0 é coincidência exata; d = 1 é um desvio típico.
    """
    if int(perfil.get("n", 0)) == 0:
        raise ValueError("perfil sem amostras: use avaliar() para o enrolamento")
    soma = 0.0
    for nome in NOMES_FEATURES:
        ref = perfil["features"][nome]
        media_ref = float(ref["media"])
        variancia = max(float(ref["variancia"]), 0.0)
        desvio = max(
            math.sqrt(variancia),
            PISO_DESVIO_RELATIVO * abs(media_ref),
            PISO_DESVIO_ABSOLUTO[nome],
        )
        z = (float(features[nome]) - media_ref) / desvio
        soma += z * z
    return math.sqrt(soma / len(NOMES_FEATURES))


def score_similaridade(distancia: float) -> float:
    """Converte distância em similaridade em (0, 1]. Com limiar 0.30, equivale a d <= 7/3 (~2.33 desvios)."""
    return 1.0 / (1.0 + distancia)


def avaliar(features: Mapping[str, float], perfil: Mapping[str, Any]) -> Avaliacao:
    if int(perfil.get("n", 0)) == 0:
        return Avaliacao(tipo="enrolamento", score=None, aprovado=True)
    score = score_similaridade(distancia_normalizada(features, perfil))
    # A decisão usa o valor sem arredondar; o registro guarda 4 casas.
    return Avaliacao(tipo="comparacao", score=round(score, 4), aprovado=score >= SCORE_MINIMO)


def atualizar_perfil(perfil: Mapping[str, Any], features: Mapping[str, float]) -> dict[str, Any]:
    """EWMA de média e variância. Chamada só depois de aprovação."""
    n_antes = int(perfil.get("n", 0))
    n = n_antes + 1
    if n_antes == 0:
        novas = {nome: {"media": float(features[nome]), "variancia": 0.0} for nome in NOMES_FEATURES}
    else:
        alpha = 1.0 / min(n, JANELA_APRENDIZADO)
        novas = {}
        for nome in NOMES_FEATURES:
            media_ref = float(perfil["features"][nome]["media"])
            variancia_ref = float(perfil["features"][nome]["variancia"])
            delta = float(features[nome]) - media_ref
            novas[nome] = {
                "media": media_ref + alpha * delta,
                "variancia": (1.0 - alpha) * (variancia_ref + alpha * delta * delta),
            }
    return {"versao": 1, "n": n, "features": novas}


def registrar_tentativa(falhas_atuais: int, aprovado: bool) -> ResultadoTentativa:
    """Controle estrito de 3 tentativas. A contagem é do atendimento (não do token), então um novo JWT não zera."""
    if not 0 <= falhas_atuais <= TENTATIVAS_MAXIMAS:
        raise ValueError("contador de falhas fora do intervalo")
    if aprovado:
        return ResultadoTentativa(falhas=falhas_atuais, restantes=TENTATIVAS_MAXIMAS - falhas_atuais, bloqueado=False)
    falhas = falhas_atuais + 1
    return ResultadoTentativa(
        falhas=falhas,
        restantes=max(TENTATIVAS_MAXIMAS - falhas, 0),
        bloqueado=falhas >= TENTATIVAS_MAXIMAS,
    )
