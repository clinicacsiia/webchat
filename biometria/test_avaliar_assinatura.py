# FLUXOGRAMA: entrada (séries sintéticas e o arquivo avaliar_assinatura.py) -> validação (asserts sobre features, score, limiar, arredondamento, tentativas, perfil) -> lógica (módulo carregado até a cola do n8n; arquivo inteiro executado com os builtins restritos do sandbox) -> saída (pytest verde ou falha com a causa)
# Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
"""Testes da validação biométrica. Rodar em biometria/: python -m pytest -q"""

import math
import random
import re
from pathlib import Path

import pytest

FONTE = (Path(__file__).parent / 'avaliar_assinatura.py').read_text(encoding='utf-8')
MARCA_COLA = '# ===== n8n: cola do nó'

# Builtins que o nó Python do n8n expôs na sonda feita na instância (tudo o que não está aqui falha lá).
BUILTINS_N8N = {
    n: __builtins__[n] if isinstance(__builtins__, dict) else getattr(__builtins__, n)
    for n in ['sorted', 'zip', 'sum', 'max', 'min', 'round', 'enumerate', 'range', 'isinstance', 'int', 'float',
              'str', 'abs', 'dict', 'list', 'tuple', 'set', 'bool', 'len', 'any', 'all', 'pow', 'callable', 'print',
              'ValueError', 'TypeError', 'KeyError', 'Exception']
}


def carregar_modulo():
    ns = {'__builtins__': dict(BUILTINS_N8N)}
    exec(FONTE.split(MARCA_COLA)[0], ns)
    return ns


M = carregar_modulo()


def rodar_como_n8n(itens):
    """Executa o arquivo inteiro como o n8n: corpo de função, builtins restritos, _items injetado."""
    corpo = '\n'.join('    ' + linha if linha else linha for linha in FONTE.split('\n'))
    ns = {'__builtins__': dict(BUILTINS_N8N)}
    exec('def __n8n__(_items):\n' + corpo + '\n', ns)
    return ns['__n8n__'](itens)


def serie_base(fase=0.0, escala=1.0, tracos=2, pontos_por_traco=30, intervalo_ms=16.0, pressao=0.6):
    pontos = []
    t = 0.0
    for k in range(tracos):
        for i in range(pontos_por_traco):
            u = i / (pontos_por_traco - 1)
            pontos.append({
                'x': 0.1 + 0.8 * u,
                'y': 0.5 + escala * 0.2 * math.sin(6.0 * u + fase + k),
                'timestamp': t,
                'pressao': pressao,
                'traco': k,
            })
            t += intervalo_ms
        t += 400.0
    return pontos


def perfil_de(pontos):
    return M['atualizar_perfil'](M['novo_perfil'](), M['extract_dynamic_features'](pontos))


# ---------- sandbox: o arquivo só usa o que o n8n oferece ----------

def test_fonte_nao_usa_construcoes_proibidas_no_sandbox():
    codigo = '\n'.join(l.split('#')[0] for l in FONTE.split('\n'))
    for proibido in [r'^\s*import\s', r'^\s*from\s+\S+\s+import', r'^\s*class\s', r'\btype\(', r'\bgetattr\(', r'\bhasattr\(',
                     r'\bopen\(', r'\beval\(', r'\bexec\(', r'(?<![A-Za-z0-9_])f["\']']:
        assert not re.search(proibido, codigo, flags=re.M), proibido


def test_arquivo_inteiro_roda_com_os_builtins_do_sandbox_e_igual_ao_modulo():
    entrada = {'pontos': serie_base(fase=0.3), 'perfil': perfil_de(serie_base(fase=0.3)), 'tentativas_falhas': 1, 'consentimento': True}
    via_n8n = rodar_como_n8n([{'json': entrada}])
    assert via_n8n == [{'json': {'resultado': M['resolver'](entrada)}}]
    assert via_n8n[0]['json']['resultado']['ok'] is True


# ---------- extração de características ----------

def test_features_valores_conhecidos():
    pontos = serie_base(tracos=2, pontos_por_traco=30, intervalo_ms=16.0, pressao=0.6)
    f = M['extract_dynamic_features'](pontos)
    assert set(f) == set(M['NOMES_FEATURES'])
    assert f['num_tracos'] == 2.0
    assert f['duracao_ms'] == pytest.approx(pontos[-1]['timestamp'] - pontos[0]['timestamp'], abs=1e-3)
    assert f['pausa_media_ms'] == pytest.approx(416.0, abs=1e-3)
    assert f['pressao_media'] == pytest.approx(0.6, abs=1e-6)
    assert f['pressao_desvio'] == pytest.approx(0.0, abs=1e-6)
    assert f['velocidade_media'] > 0
    assert all(math.isfinite(v) for v in f.values())


def test_features_sao_deterministicas():
    assert M['extract_dynamic_features'](serie_base(fase=1.2)) == M['extract_dynamic_features'](list(serie_base(fase=1.2)))


# ---------- validação da série (não conta como tentativa) ----------

def test_serie_valida_e_aceita():
    assert len(M['validar_serie'](serie_base())) == 60


def test_serie_curta_demais():
    with pytest.raises(ValueError, match='entre'):
        M['validar_serie'](serie_base()[:5])


def test_serie_que_nao_e_lista():
    with pytest.raises(ValueError, match='entre'):
        M['validar_serie']('lixo')


def test_tempo_fora_de_ordem():
    pontos = serie_base()
    pontos[10]['timestamp'] = pontos[9]['timestamp'] - 5
    with pytest.raises(ValueError, match='fora de ordem'):
        M['validar_serie'](pontos)


def test_valor_nao_finito():
    pontos = serie_base()
    pontos[3]['x'] = float('nan')
    with pytest.raises(ValueError, match='não finito'):
        M['validar_serie'](pontos)
    pontos = serie_base()
    pontos[3]['y'] = float('inf')
    with pytest.raises(ValueError, match='não finito'):
        M['validar_serie'](pontos)


def test_ponto_malformado_e_nulo():
    pontos = serie_base()
    pontos[2] = {'x': None, 'y': 0.5, 'timestamp': 1.0}
    with pytest.raises(ValueError, match='malformado'):
        M['validar_serie'](pontos)
    pontos = serie_base()
    pontos[2] = 'texto'
    with pytest.raises(ValueError, match='malformado'):
        M['validar_serie'](pontos)


def test_duracao_curta():
    with pytest.raises(ValueError, match='duração'):
        M['validar_serie'](serie_base(pontos_por_traco=25, intervalo_ms=2.0, tracos=1))


def test_fora_do_canvas_e_clamp_da_borda():
    pontos = serie_base()
    pontos[0]['x'] = -0.03
    assert M['validar_serie'](pontos)[0]['x'] == 0.0
    pontos = serie_base()
    pontos[0]['x'] = 1.5
    with pytest.raises(ValueError, match='fora do canvas'):
        M['validar_serie'](pontos)


# ---------- enrolamento, comparação, limiar e aprendizado ----------

def test_enrolamento_aprova_sem_score():
    av = M['avaliar'](M['extract_dynamic_features'](serie_base()), M['novo_perfil']())
    assert av == {'tipo': 'enrolamento', 'score': None, 'aprovado': True}


def test_mesma_assinatura_depois_do_enrolamento_tem_score_maximo():
    pontos = serie_base(fase=0.7)
    av = M['avaliar'](M['extract_dynamic_features'](pontos), perfil_de(pontos))
    assert av['tipo'] == 'comparacao' and av['score'] == pytest.approx(1.0, abs=1e-4) and av['aprovado'] is True


def test_assinatura_muito_diferente_e_reprovada():
    perfil = perfil_de(serie_base(fase=0.0, escala=1.0, tracos=2, pontos_por_traco=30, intervalo_ms=16.0))
    diferente = serie_base(fase=2.5, escala=2.0, tracos=1, pontos_por_traco=40, intervalo_ms=60.0)
    av = M['avaliar'](M['extract_dynamic_features'](diferente), perfil)
    assert av['score'] < M['SCORE_MINIMO'] and av['aprovado'] is False


def test_limiar_030_equivale_a_distancia_de_7_tercos():
    assert M['score_similaridade'](7 / 3) == pytest.approx(0.30, abs=1e-9)


def test_decisao_usa_o_score_arredondado_que_o_banco_confere():
    # Regressão: score bruto 0.29996 arredondava para 0.3 e o Python reprovava enquanto o banco aprovaria 0.3000 >= 0.30.
    rnd = random.Random(7)
    perfil = perfil_de(serie_base(fase=0.4))
    for _ in range(300):
        p = serie_base(fase=rnd.uniform(0, 6), escala=rnd.uniform(0.3, 2.2), tracos=rnd.randint(1, 4),
                       pontos_por_traco=rnd.randint(20, 60), intervalo_ms=rnd.uniform(16, 40), pressao=rnd.uniform(0.2, 0.9))
        av = M['avaliar'](M['extract_dynamic_features'](p), perfil)
        assert av['aprovado'] == (av['score'] >= 0.30)
        assert av['score'] == round(av['score'], 4)


def test_perfil_aprende_sem_pular_para_o_valor_novo():
    perfil = perfil_de(serie_base(intervalo_ms=16.0))
    antes = perfil['features']['duracao_ms']['media']
    novo = M['extract_dynamic_features'](serie_base(intervalo_ms=30.0))
    atualizado = M['atualizar_perfil'](perfil, novo)
    assert atualizado['n'] == 2
    depois = atualizado['features']['duracao_ms']['media']
    assert min(antes, novo['duracao_ms']) < depois < max(antes, novo['duracao_ms'])


def test_taxa_de_aprendizado_tem_piso_de_1_sobre_20():
    perfil = M['novo_perfil']()
    f = M['extract_dynamic_features'](serie_base())
    for _ in range(60):
        perfil = M['atualizar_perfil'](perfil, f)
    outro = dict(f)
    outro['duracao_ms'] = f['duracao_ms'] + 1000.0
    movido = M['atualizar_perfil'](perfil, outro)['features']['duracao_ms']['media'] - perfil['features']['duracao_ms']['media']
    assert movido == pytest.approx(1000.0 / 20, rel=1e-6)


# ---------- controle de 3 tentativas ----------

def test_tres_falhas_bloqueiam():
    r1 = M['registrar_tentativa'](0, False)
    assert r1 == {'falhas': 1, 'restantes': 2, 'bloqueado': False}
    r2 = M['registrar_tentativa'](r1['falhas'], False)
    assert r2 == {'falhas': 2, 'restantes': 1, 'bloqueado': False}
    r3 = M['registrar_tentativa'](r2['falhas'], False)
    assert r3 == {'falhas': 3, 'restantes': 0, 'bloqueado': True}


def test_aprovacao_mantem_o_contador_e_contador_invalido_falha():
    assert M['registrar_tentativa'](2, True) == {'falhas': 2, 'restantes': 1, 'bloqueado': False}
    with pytest.raises(ValueError):
        M['registrar_tentativa'](4, False)
    with pytest.raises(ValueError):
        M['registrar_tentativa'](-1, False)


# ---------- resolver: o que o n8n chama ----------

def entrada(pontos, perfil=None, falhas=0, consentimento=True):
    return {'pontos': pontos, 'perfil': perfil if perfil is not None else {}, 'tentativas_falhas': falhas, 'consentimento': consentimento}


def test_resolver_sem_consentimento_nao_avalia():
    assert M['resolver'](entrada(serie_base(), consentimento=False)) == {'ok': False, 'erro': 'consentimento_obrigatorio'}
    assert M['resolver'](entrada(serie_base(), consentimento='true'))['erro'] == 'consentimento_obrigatorio'


def test_resolver_serie_ruim_nao_conta_tentativa():
    r = M['resolver'](entrada(serie_base()[:5], falhas=1))
    assert r['ok'] is False and r['erro'] == 'serie_invalida' and 'aprovado' not in r


def test_resolver_primeiro_uso_e_enrolamento_com_perfil_novo():
    r = M['resolver'](entrada(serie_base()))
    assert r['ok'] and r['aprovado'] and r['tipo'] == 'enrolamento' and r['score'] is None
    assert r['perfil_n_base'] == 0 and r['perfil_novo']['n'] == 1 and r['consentimento'] is True


def test_resolver_comparacao_aprovada_aprende():
    pontos = serie_base(fase=0.5)
    r = M['resolver'](entrada(pontos, perfil=perfil_de(pontos)))
    assert r['aprovado'] and r['tipo'] == 'comparacao' and r['score'] == pytest.approx(1.0, abs=1e-4)
    assert r['perfil_n_base'] == 1 and r['perfil_novo']['n'] == 2


def test_resolver_reprovacao_nao_aprende_e_conta_ate_bloquear():
    perfil = perfil_de(serie_base(fase=0.0))
    diferente = serie_base(fase=2.5, escala=2.0, tracos=1, pontos_por_traco=40, intervalo_ms=60.0)
    r1 = M['resolver'](entrada(diferente, perfil=perfil, falhas=0))
    assert r1['aprovado'] is False and 'perfil_novo' not in r1 and r1['tentativas_restantes'] == 2 and r1['bloqueado'] is False
    r3 = M['resolver'](entrada(diferente, perfil=perfil, falhas=2))
    assert r3['aprovado'] is False and r3['tentativas_restantes'] == 0 and r3['bloqueado'] is True


def test_resolver_perfil_vazio_do_banco_vira_enrolamento():
    assert M['resolver'](entrada(serie_base(), perfil={}))['tipo'] == 'enrolamento'
    assert M['resolver'](entrada(serie_base(), perfil={'n': 0}))['tipo'] == 'enrolamento'
