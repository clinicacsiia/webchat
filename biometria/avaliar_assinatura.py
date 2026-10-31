# FLUXOGRAMA: entrada (item do n8n: pontos [{x, y, timestamp, pressao, traco}], perfil do paciente, tentativas_falhas, consentimento) -> validação (consentimento, tamanho, valores finitos, tempo crescente, duração, canvas normalizado) -> lógica (features dinâmicas -> distância normalizada contra o perfil -> score = 1/(1+d) arredondado -> limiar 0.30 -> EWMA do perfil só se aprovado; contador de 3 tentativas) -> saída (resultado para assinatura_registrar: aprovado, tipo, score, características, perfil novo, tentativas restantes, bloqueio)
# Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
#
# Este arquivo é o corpo do nó Code (Python nativo) do workflow "Fila - validar assinatura" do n8n E o módulo testado
# por biometria/test_avaliar_assinatura.py. O sandbox do n8n não aceita import, class, type, getattr nem hasattr:
# por isso só há funções, dicts e listas. A cola com o n8n começa depois da linha "n8n: cola do nó".

SCORE_MINIMO = 0.30
TENTATIVAS_MAXIMAS = 3
MIN_PONTOS = 20
MAX_PONTOS = 5000
DURACAO_MIN_MS = 300.0
DURACAO_MAX_MS = 60000.0
MAX_TRACOS = 200
TOLERANCIA_BORDA = 0.05          # o pointer capture pode levar o ponteiro levemente para fora do canvas
JANELA_APRENDIZADO = 20          # taxa de aprendizado mínima = 1/20: o perfil segue o paciente sem derivar sozinho
PISO_DESVIO_RELATIVO = 0.10      # desvio nunca menor que 10% da média do próprio paciente
INFINITO = float('inf')

NOMES_FEATURES = [
    'velocidade_media',
    'jitter',
    'duracao_ms',
    'pressao_media',
    'pressao_desvio',
    'num_tracos',
    'pausa_media_ms',
]

# Piso absoluto do desvio por feature: uma feature de média zero (ex.: pausa quando só há um traço) não pode
# transformar qualquer variação pequena em rejeição. Unidades: x e y normalizados em [0, 1], tempo em ms.
PISO_DESVIO_ABSOLUTO = {
    'velocidade_media': 0.0005,
    'jitter': 0.001,
    'duracao_ms': 50.0,
    'pressao_media': 0.05,
    'pressao_desvio': 0.02,
    'num_tracos': 1.0,
    'pausa_media_ms': 300.0,
}


def _finito(v):
    return v == v and v != INFINITO and v != -INFINITO     # v == v é falso para NaN


def _media(valores):
    return sum(valores) / len(valores) if valores else 0.0


def _limitar(v, minimo, maximo):
    return min(max(v, minimo), maximo)


def validar_serie(pontos):
    """Confere e normaliza a série. Lança ValueError com a causa; devolve uma cópia limpa."""
    if not isinstance(pontos, list) or not (MIN_PONTOS <= len(pontos) <= MAX_PONTOS):
        raise ValueError('a série precisa ter entre ' + str(MIN_PONTOS) + ' e ' + str(MAX_PONTOS) + ' pontos')

    limpos = []
    tempo_anterior = None
    for indice, ponto in enumerate(pontos):
        try:
            x = float(ponto['x'])
            y = float(ponto['y'])
            t = float(ponto['timestamp'])
            pressao = float(ponto.get('pressao', 0.0) or 0.0)
            traco = int(ponto.get('traco', 0) or 0)
        except Exception:
            raise ValueError('ponto ' + str(indice) + ' malformado')

        if not (_finito(x) and _finito(y) and _finito(t) and _finito(pressao)):
            raise ValueError('ponto ' + str(indice) + ' com valor não finito')
        if tempo_anterior is not None and t < tempo_anterior:
            raise ValueError('ponto ' + str(indice) + ' fora de ordem no tempo')
        tempo_anterior = t
        if not (-TOLERANCIA_BORDA <= x <= 1 + TOLERANCIA_BORDA and -TOLERANCIA_BORDA <= y <= 1 + TOLERANCIA_BORDA):
            raise ValueError('ponto ' + str(indice) + ' fora do canvas normalizado')
        if not (0 <= traco < MAX_TRACOS):
            raise ValueError('ponto ' + str(indice) + ' com índice de traço inválido')

        limpos.append({
            'x': _limitar(x, 0.0, 1.0),
            'y': _limitar(y, 0.0, 1.0),
            'timestamp': t,
            'pressao': _limitar(pressao, 0.0, 1.0),
            'traco': traco,
        })

    duracao = limpos[-1]['timestamp'] - limpos[0]['timestamp']
    if not (DURACAO_MIN_MS <= duracao <= DURACAO_MAX_MS):
        raise ValueError('duração da assinatura fora do intervalo aceito')
    return limpos


def extract_dynamic_features(pontos):
    """Extrai as 7 características dinâmicas (valida a série antes)."""
    serie = validar_serie(pontos)

    por_traco = {}
    for ponto in serie:
        if ponto['traco'] not in por_traco:
            por_traco[ponto['traco']] = []
        por_traco[ponto['traco']].append(ponto)
    sequencias = [por_traco[k] for k in sorted(por_traco)]

    velocidades = []
    jitters = []
    for seq in sequencias:
        for a, b in zip(seq, seq[1:]):
            dt = b['timestamp'] - a['timestamp']
            if dt > 0:
                dx = b['x'] - a['x']
                dy = b['y'] - a['y']
                velocidades.append((dx * dx + dy * dy) ** 0.5 / dt)
        for a, b, c in zip(seq, seq[1:], seq[2:]):
            # segunda diferença: quanto o traço "treme" entre amostras consecutivas
            ddx = c['x'] - 2 * b['x'] + a['x']
            ddy = c['y'] - 2 * b['y'] + a['y']
            jitters.append((ddx * ddx + ddy * ddy) ** 0.5)

    pausas = [proximo[0]['timestamp'] - anterior[-1]['timestamp'] for anterior, proximo in zip(sequencias, sequencias[1:])]

    pressoes = [p['pressao'] for p in serie if p['pressao'] > 0]
    media_pressao = _media(pressoes)
    desvio_pressao = (sum([(p - media_pressao) ** 2 for p in pressoes]) / len(pressoes)) ** 0.5 if pressoes else 0.0

    return {
        'velocidade_media': round(_media(velocidades), 8),
        'jitter': round(_media(jitters), 8),
        'duracao_ms': round(serie[-1]['timestamp'] - serie[0]['timestamp'], 3),
        'pressao_media': round(media_pressao, 6),
        'pressao_desvio': round(desvio_pressao, 6),
        'num_tracos': float(len(sequencias)),
        'pausa_media_ms': round(_media(pausas), 3),
    }


def novo_perfil():
    return {
        'versao': 1,
        'n': 0,
        'features': {nome: {'media': 0.0, 'variancia': 0.0} for nome in NOMES_FEATURES},
    }


def distancia_normalizada(features, perfil):
    """Distância euclidiana média quadrática sobre z-scores contra o perfil do próprio paciente.

    d = sqrt( mean_i ( (f_i - mu_i) / sigma_i )^2 ). d = 0 é coincidência exata; d = 1 é um desvio típico.
    """
    if int(perfil.get('n', 0)) == 0:
        raise ValueError('perfil sem amostras: use avaliar() para o enrolamento')
    soma = 0.0
    for nome in NOMES_FEATURES:
        ref = perfil['features'][nome]
        media_ref = float(ref['media'])
        variancia = max(float(ref['variancia']), 0.0)
        desvio = max(variancia ** 0.5, PISO_DESVIO_RELATIVO * abs(media_ref), PISO_DESVIO_ABSOLUTO[nome])
        z = (float(features[nome]) - media_ref) / desvio
        soma += z * z
    return (soma / len(NOMES_FEATURES)) ** 0.5


def score_similaridade(distancia):
    """Converte distância em similaridade em (0, 1]. Com limiar 0.30, equivale a d <= 7/3 (~2,33 desvios)."""
    return 1.0 / (1.0 + distancia)


def avaliar(features, perfil):
    """Enrolamento (sem perfil) aprova sem score. Comparação decide pelo score JÁ arredondado em 4 casas,
    o mesmo valor que o banco confere (score >= 0.30) e grava."""
    if int(perfil.get('n', 0)) == 0:
        return {'tipo': 'enrolamento', 'score': None, 'aprovado': True}
    score = round(score_similaridade(distancia_normalizada(features, perfil)), 4)
    return {'tipo': 'comparacao', 'score': score, 'aprovado': score >= SCORE_MINIMO}


def atualizar_perfil(perfil, features):
    """EWMA de média e variância. Chamada só depois de aprovação."""
    n_antes = int(perfil.get('n', 0))
    n = n_antes + 1
    if n_antes == 0:
        novas = {nome: {'media': float(features[nome]), 'variancia': 0.0} for nome in NOMES_FEATURES}
    else:
        alpha = 1.0 / min(n, JANELA_APRENDIZADO)
        novas = {}
        for nome in NOMES_FEATURES:
            media_ref = float(perfil['features'][nome]['media'])
            variancia_ref = float(perfil['features'][nome]['variancia'])
            delta = float(features[nome]) - media_ref
            novas[nome] = {
                'media': media_ref + alpha * delta,
                'variancia': (1.0 - alpha) * (variancia_ref + alpha * delta * delta),
            }
    return {'versao': 1, 'n': n, 'features': novas}


def registrar_tentativa(falhas_atuais, aprovado):
    """Controle estrito de 3 tentativas. A contagem é do atendimento, não do token: um link novo não zera.
    O banco refaz esta conta (assinatura_registrar) e é a autoridade; aqui ela só gera a mensagem."""
    if not (0 <= falhas_atuais <= TENTATIVAS_MAXIMAS):
        raise ValueError('contador de falhas fora do intervalo')
    if aprovado:
        return {'falhas': falhas_atuais, 'restantes': TENTATIVAS_MAXIMAS - falhas_atuais, 'bloqueado': False}
    falhas = falhas_atuais + 1
    return {'falhas': falhas, 'restantes': max(TENTATIVAS_MAXIMAS - falhas, 0), 'bloqueado': falhas >= TENTATIVAS_MAXIMAS}


def resolver(entrada):
    """Uma assinatura de ponta a ponta. Nunca lança: erro de série vira {'ok': False, 'erro': ...}."""
    if entrada.get('consentimento') is not True:
        return {'ok': False, 'erro': 'consentimento_obrigatorio'}
    perfil = entrada.get('perfil') or {}
    if int(perfil.get('n', 0) or 0) == 0:
        perfil = novo_perfil()
    try:
        features = extract_dynamic_features(entrada.get('pontos'))
        avaliacao = avaliar(features, perfil)
        tentativa = registrar_tentativa(int(entrada.get('tentativas_falhas', 0) or 0), avaliacao['aprovado'])
    except ValueError as erro:
        return {'ok': False, 'erro': 'serie_invalida', 'detalhe': str(erro)}

    saida = {
        'ok': True,
        'aprovado': avaliacao['aprovado'],
        'tipo': avaliacao['tipo'],
        'score': avaliacao['score'],
        'consentimento': True,
        'perfil_n_base': int(perfil.get('n', 0)),
        'caracteristicas': features,
        'tentativas_restantes': tentativa['restantes'],
        'bloqueado': tentativa['bloqueado'],
    }
    if avaliacao['aprovado']:
        saida['perfil_novo'] = atualizar_perfil(perfil, features)
    return saida


# ===== n8n: cola do nó (o resto do arquivo é testado como módulo; daqui para baixo só roda no n8n) =====
saidas = []
for item in _items:
    saidas.append({'json': {'resultado': resolver(item['json'])}})
return saidas
