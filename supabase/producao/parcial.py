#!/usr/bin/env python3
"""FLUXOGRAMA: entrada (funcoes.json com SÓ as funções que mudaram e estrutura.json com SÓ as tabelas/visões novas ou alteradas, lidas da produção) -> validação (mesma recusa de dado pessoal/segredo do gerar.py) -> lógica (troca ou acrescenta essas funções, tabelas e visões no retrato existente, sem mexer no resto) -> saída (funcoes/, estrutura.sql e indice.json atualizados)
Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (atualização parcial do retrato; o retrato inteiro continua sendo refeito por gerar.py)

Uso:  python3 supabase/producao/parcial.py <funcoes.json> <estrutura.json>
  funcoes.json   = lista como a CONSULTA 1 de consultas.sql, filtrada pelas funções que mudaram.
  estrutura.json = objeto com 'gerado_em', 'tabelas', 'visoes' (como a CONSULTA 2, filtrada) e 'config_chaves' (todas).
Quando o banco mudar muito, refaça o retrato inteiro com gerar.py.
"""
import hashlib
import json
import os
import re
import sys

import gerar

AQUI = gerar.AQUI


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    novas = json.load(open(sys.argv[1], encoding='utf-8'))
    est = json.load(open(sys.argv[2], encoding='utf-8'))
    gerar.conferir_privacidade(json.dumps(novas, ensure_ascii=False) + json.dumps(est, ensure_ascii=False))
    ind = json.load(open(os.path.join(AQUI, 'indice.json'), encoding='utf-8'))
    tabelas_conhecidas = [t['nome'] for t in ind['tabelas']] + [t['nome'] for t in est.get('tabelas', [])]

    # ---- funções: um arquivo por nome (substitui o arquivo inteiro com todas as sobrecargas passadas) e o índice
    por_nome = {}
    for f in novas:
        f['def'] = gerar.qualificar_tipos_de_tabela(f['def'], tabelas_conhecidas)
        por_nome.setdefault(f['n'], []).append(f)
    antigas = ind['funcoes']
    ind['funcoes'] = []
    novos_indices = {}
    for nome, lista in sorted(por_nome.items()):
        with open(os.path.join(AQUI, 'funcoes', nome + '.sql'), 'w', encoding='utf-8') as arq:
            for f in lista:
                quem = [r for r, k in (('anon', 'anon'), ('authenticated', 'auth'), ('service_role', 'srv')) if f[k]]
                arq.write(f"-- public.{nome}({f['a']})\n-- Pode executar: {', '.join(quem) or 'ninguém pela API (só o dono/gatilhos/rotinas)'}{' (PUBLIC)' if f['pub'] else ''}\n")
                arq.write(f['def'].rstrip() + ';\n\n')
                corpo = re.search(r'AS \$function\$(.*)\$function\$\s*$', f['def'], re.S)
                novos_indices.setdefault(nome, []).append({
                    'nome': nome, 'args': gerar.cabecalho(f['def']),
                    'definer': 'SECURITY DEFINER' in f['def'].split('AS $function$')[0],
                    'gatilho': bool(re.search(r'RETURNS trigger', f['def'].split('AS $function$')[0])),
                    'anon': f['anon'], 'authenticated': f['auth'], 'publico': f['pub'],
                    'md5': hashlib.md5(re.sub(r'\s+', ' ', corpo.group(1) if corpo else f['def']).strip().encode()).hexdigest(),
                })
    # o índice mantém a ordem que já tinha: quem foi trocado fica no mesmo lugar; quem é novo entra antes do primeiro nome maior
    emitidos = set()
    for x in antigas:
        if x['nome'] in novos_indices:
            if x['nome'] not in emitidos:
                ind['funcoes'] += novos_indices[x['nome']]
                emitidos.add(x['nome'])
            continue
        for nome in sorted(n for n in novos_indices if n not in emitidos and n < x['nome']):
            ind['funcoes'] += novos_indices[nome]
            emitidos.add(nome)
        ind['funcoes'].append(x)
    for nome in sorted(n for n in novos_indices if n not in emitidos):
        ind['funcoes'] += novos_indices[nome]

    # ---- estrutura.sql: blocos novos entram antes das chaves estrangeiras / visões / gatilhos
    sql = open(os.path.join(AQUI, 'estrutura.sql'), encoding='utf-8').read()
    nomes_t = {t['nome'] for t in est.get('tabelas', [])}
    nomes_v = {v['nome'] for v in est.get('visoes', [])}
    for n in nomes_t:   # tabela já descrita antes: tira o bloco e as chaves estrangeiras antigas
        sql = re.sub(r'\ncreate table public\.' + n + r' \(.*?\n\);(?:\n(?!create table|\n-- =====)[^\n]*)*', '', sql, flags=re.S)
        sql = re.sub(r'\nalter table public\.' + n + r' add constraint [^\n]*;', '', sql)
    for n in nomes_v:
        sql = re.sub(r'\ncreate (?:materialized )?view public\.' + n + r'(?: with \([^)]*\))? as\n.*?;(?:\n(?:create index|-- concessão)[^\n]*)*', '', sql, flags=re.S)
    sql = re.sub(r'\n(-- ===== Tabelas \()(\d+)\)', lambda m: f"\n{m.group(1)}{len(ind['tabelas']) - len([t for t in ind['tabelas'] if t['nome'] in nomes_t]) + len(nomes_t)})", sql)
    novas_t = ''.join('\n\n' + gerar.sql_tabela(t) for t in est.get('tabelas', []))
    marca_fk = '\n-- ===== Chaves estrangeiras'
    sql = sql.replace(marca_fk, novas_t + '\n' + marca_fk.lstrip('\n') if False else novas_t + '\n' + marca_fk, 1)
    fks = ''.join(f"\nalter table public.{t['nome']} add constraint {k['nome']} {k['def']};" for t in est.get('tabelas', []) for k in (t['restricoes'] or []) if k['tipo'] == 'f')
    marca_v = '\n\n-- ===== Visões'
    i = sql.index(marca_v)
    sql = sql[:i] + fks + sql[i:]
    if est.get('visoes'):
        blocos = ''
        for v in est['visoes']:
            op = f" with ({', '.join(v['opcoes'])})" if v.get('opcoes') else ''
            blocos += f"\n\ncreate {'materialized view' if v['tipo'] == 'm' else 'view'} public.{v['nome']}{op} as\n{v['def'].rstrip().rstrip(';')};"
            blocos += ''.join('\n' + x + ';' for x in (v.get('indices') or []))
            blocos += ''.join(f"\n-- concessão a {p}: {x}" for p, x in sorted((v.get('concessoes') or {}).items()))
        marca_g = '\n\n-- ===== Gatilhos'
        j = sql.index(marca_g)
        sql = sql[:j] + blocos + sql[j:]
    if est.get('config_chaves'):
        sql = re.sub(r'(-- ===== Chaves existentes em public\.config[^\n]*\n)-- [^\n]*', lambda m: m.group(1) + '-- ' + ', '.join(est['config_chaves']), sql)
    sql = sql.replace('-- Tirado em ', f"-- Atualização parcial em {est['gerado_em']} (funções app_* e painel_app_*, tabelas app_*). Retrato inteiro tirado em ", 1) if 'Atualização parcial em' not in sql else re.sub(r'-- Atualização parcial em [^ ]+ ', f"-- Atualização parcial em {est['gerado_em']} ", sql, 1)
    open(os.path.join(AQUI, 'estrutura.sql'), 'w', encoding='utf-8').write(sql)

    # ---- índice: tabelas e visões
    for t in est.get('tabelas', []):
        ind['tabelas'] = [x for x in ind['tabelas'] if x['nome'] != t['nome']]
        ind['tabelas'].append({'nome': t['nome'], 'colunas': [c['nome'] for c in t['colunas']], 'rls': t['rls'], 'politicas': len(t['politicas'] or [])})
    for v in est.get('visoes', []):
        if v['nome'] not in ind['visoes']:
            ind['visoes'].append(v['nome'])
    ind['gatilhos'] = sorted(set(ind['gatilhos']) | {g for t in est.get('tabelas', []) for g in (t['gatilhos'] or [])})
    if est.get('config_chaves'):
        ind['config_chaves'] = est['config_chaves']
    json.dump(ind, open(os.path.join(AQUI, 'indice.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    open(os.path.join(AQUI, 'indice.json'), 'a', encoding='utf-8').write('\n')
    print(f"{len(ind['funcoes'])} funções, {len(ind['tabelas'])} tabelas, {len(ind['visoes'])} visões no retrato (parcial: {len(por_nome)} funções, {len(nomes_t)} tabelas, {len(nomes_v)} visões)")


if __name__ == '__main__':
    main()
