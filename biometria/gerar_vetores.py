# FLUXOGRAMA: entrada (séries sintéticas com semente fixa + o módulo de referência avaliar_assinatura.py) -> validação (carrega o módulo sem a cola do n8n) -> lógica (roda resolver() em casos de enrolamento, comparação aprovada/reprovada, série inválida, bloqueio) -> saída (supabase/functions/fila-validar-assinatura/vetores.json com entrada e resultado esperado)
# Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
#
# O Python é a REFERÊNCIA do algoritmo; a Edge Function usa o porte em TypeScript. Este script congela o que o Python devolve
# e o teste supabase/functions/fila-validar-assinatura/avaliacao.test.ts exige o mesmo resultado do TypeScript.
# Rodar: python3 biometria/gerar_vetores.py   (só quando o algoritmo mudar de propósito; o arquivo gerado vai para o Git)
import json
import math
import os
import random

AQUI = os.path.dirname(os.path.abspath(__file__))
MARCA = '# ===== n8n: cola do nó'


def carregar():
    codigo = open(os.path.join(AQUI, 'avaliar_assinatura.py'), encoding='utf-8').read().split(MARCA)[0]
    ns = {}
    exec(codigo, ns)
    return ns


def assinatura(rng, tracos=2, por_traco=40, ruido=0.002, escala=1.0, pressao=True, inicio=1000.0, passo=16.0):
    pontos = []
    t = inicio
    for k in range(tracos):
        for i in range(por_traco):
            a = i / (por_traco - 1)
            x = 0.15 + 0.7 * a * escala + rng.uniform(-ruido, ruido)
            y = 0.5 + 0.25 * math.sin(a * math.pi * (2 + k)) * escala + rng.uniform(-ruido, ruido)
            p = {'x': round(x, 6), 'y': round(y, 6), 'timestamp': round(t, 3), 'traco': k}
            if pressao:
                p['pressao'] = round(0.4 + 0.3 * math.sin(a * math.pi) + rng.uniform(-0.02, 0.02), 4)
            pontos.append(p)
            t += passo + rng.uniform(-2, 2)
        t += 250.0
    return pontos


def perfil_depois(M, pontos_lista):
    perfil = M['novo_perfil']()
    for pts in pontos_lista:
        f = M['extract_dynamic_features'](pts)
        perfil = M['atualizar_perfil'](perfil, f)
    return perfil


def main():
    M = carregar()
    rng = random.Random(20261103)
    vetores = []

    def add(nome, entrada):
        vetores.append({'nome': nome, 'entrada': entrada, 'esperado': M['resolver'](entrada)})

    base = [assinatura(rng) for _ in range(5)]
    perfil = perfil_depois(M, base)

    add('enrolamento: primeira assinatura aprova sem score', {'consentimento': True, 'perfil': {}, 'tentativas_falhas': 0, 'pontos': assinatura(rng)})
    add('comparação: assinatura parecida aprova e atualiza o perfil', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': assinatura(rng)})
    add('comparação: assinatura muito diferente reprova (1ª falha)', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': assinatura(rng, tracos=6, por_traco=25, ruido=0.04, escala=0.4, passo=60.0)})
    add('comparação: 2ª falha', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 1, 'pontos': assinatura(rng, tracos=5, por_traco=30, ruido=0.05, escala=0.3, passo=45.0)})
    add('comparação: 3ª falha bloqueia', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 2, 'pontos': assinatura(rng, tracos=6, por_traco=25, ruido=0.04, escala=0.4, passo=60.0)})
    add('sem pressão (mouse): aprova no enrolamento', {'consentimento': True, 'perfil': {}, 'tentativas_falhas': 0, 'pontos': assinatura(rng, pressao=False)})
    add('sem consentimento é recusado', {'consentimento': False, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': assinatura(rng)})
    add('série curta demais', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': assinatura(rng)[:5]})
    fora = assinatura(rng); fora[3]['x'] = 2.0
    add('ponto fora do canvas', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': fora})
    desordem = assinatura(rng); desordem[10]['timestamp'] = 0.0
    add('tempo fora de ordem', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': desordem})
    rapida = assinatura(rng, passo=1.0)
    add('duração curta demais', {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': 0, 'pontos': rapida})
    for i in range(12):
        add('aleatório %d' % i, {'consentimento': True, 'perfil': perfil, 'tentativas_falhas': i % 3,
                                 'pontos': assinatura(rng, tracos=1 + i % 4, por_traco=25 + i * 3, ruido=0.001 * (1 + i), escala=0.5 + i * 0.05, passo=10.0 + i * 5)})

    destino = os.path.join(AQUI, '..', 'supabase', 'functions', 'fila-validar-assinatura', 'vetores.json')
    with open(destino, 'w', encoding='utf-8') as f:
        json.dump(vetores, f, ensure_ascii=False, indent=1)
    print('vetores:', len(vetores), '->', os.path.normpath(destino))


main()
