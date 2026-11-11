#!/usr/bin/env python3
"""FLUXOGRAMA: entrada (dois arquivos JSON com o resultado das consultas de consultas.sql, rodadas no banco de produção) -> validação (recusa se achar e-mail, telefone, chave ou token no texto) -> lógica (escreve um arquivo por função, a estrutura das tabelas e um índice enxuto) -> saída (pasta supabase/producao/ atualizada)
Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial

Retrato da ESTRUTURA do banco de produção (nenhuma linha de tabela, nenhum valor de configuração, nenhum segredo).
Uso:  python3 supabase/producao/gerar.py <funcoes.json> <estrutura.json>
"""
import hashlib
import json
import os
import re
import shutil
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
SUSPEITOS = [
    ('e-mail', r'[\w.+-]+@[\w-]+\.[a-z]{2,}'),
    ('número longo (telefone/CPF)', r'(?<![\d.])(?!0{10,14}(?!\d))\d{10,14}(?![\d.])'),
    ('token JWT', r'eyJ[A-Za-z0-9_-]{20,}'),
    ('chave do Supabase', r'sb_(?:secret|publishable)_[A-Za-z0-9_-]+'),
    ('Bearer', r'Bearer\s+[A-Za-z0-9._-]{16,}'),
]


def conferir_privacidade(texto):
    achados = []
    for rotulo, rx in SUSPEITOS:
        n = len(re.findall(rx, texto))
        if n:
            achados.append(f'{rotulo}: {n}')
    if achados:
        sys.exit('RECUSADO: o retrato tem cara de dado pessoal ou segredo (' + '; '.join(achados) + '). Nada foi gravado.')


def cabecalho(defn):
    """Lista de argumentos de entrada (nome, tem padrão) a partir do texto de pg_get_functiondef."""
    ini = defn.index('(') + 1
    prof, i = 1, ini
    while prof and i < len(defn):
        prof += {'(': 1, ')': -1}.get(defn[i], 0)
        i += 1
    bruto = defn[ini:i - 1]
    partes, buf, prof = [], '', 0
    for c in bruto:
        prof += {'(': 1, '[': 1, ')': -1, ']': -1}.get(c, 0)
        if c == ',' and prof == 0:
            partes.append(buf)
            buf = ''
        else:
            buf += c
    if buf.strip():
        partes.append(buf)
    args = []
    for p in partes:
        p = p.strip()
        if re.match(r'(OUT|TABLE)\b', p):
            continue
        p = re.sub(r'^(IN|INOUT|VARIADIC)\s+', '', p)
        args.append({'nome': p.split()[0], 'padrao': ' DEFAULT ' in p})
    return args


def gerar_funcoes(funcoes):
    pasta = os.path.join(AQUI, 'funcoes')
    shutil.rmtree(pasta, ignore_errors=True)
    os.makedirs(pasta)
    por_nome, indice = {}, []
    for f in funcoes:
        por_nome.setdefault(f['n'], []).append(f)
        corpo = re.search(r'AS \$function\$(.*)\$function\$\s*$', f['def'], re.S)
        indice.append({
            'nome': f['n'],
            'args': cabecalho(f['def']),
            'definer': 'SECURITY DEFINER' in f['def'].split('AS $function$')[0],
            'gatilho': bool(re.search(r'RETURNS trigger', f['def'].split('AS $function$')[0])),
            'anon': f['anon'], 'authenticated': f['auth'], 'publico': f['pub'],
            'md5': hashlib.md5(re.sub(r'\s+', ' ', corpo.group(1) if corpo else f['def']).strip().encode()).hexdigest(),
        })
    for nome, lista in sorted(por_nome.items()):
        with open(os.path.join(pasta, nome + '.sql'), 'w', encoding='utf-8') as arq:
            for f in lista:
                quem = [r for r, k in (('anon', 'anon'), ('authenticated', 'auth'), ('service_role', 'srv')) if f[k]]
                arq.write(f"-- public.{nome}({f['a']})\n-- Pode executar: {', '.join(quem) or 'ninguém pela API (só o dono/gatilhos/rotinas)'}{' (PUBLIC)' if f['pub'] else ''}\n")
                arq.write(f['def'].rstrip() + ';\n\n')
    return indice


def sql_tabela(t):
    linhas = []
    for c in t['colunas']:
        s = f"  {c['nome']} {c['tipo']}"
        if c.get('identidade'):
            s += ' generated ' + ('always' if c['identidade'] == 'a' else 'by default') + ' as identity'
        elif c.get('gerada'):
            s += f" generated always as ({c['padrao']}) stored"
        elif c.get('padrao') is not None:
            s += ' default ' + c['padrao']
        if c['nn']:
            s += ' not null'
        linhas.append(s)
    for k in (t['restricoes'] or []):
        if k['tipo'] != 'f':
            linhas.append(f"  constraint {k['nome']} {k['def']}")
    out = [f"create table public.{t['nome']} (", ',\n'.join(linhas), ');']
    if t.get('comentario'):
        out.append("comment on table public." + t['nome'] + " is '" + t['comentario'].replace("'", "''") + "';")
    for i in (t['indices'] or []):
        out.append(i + ';')
    if t['rls']:
        out.append(f"alter table public.{t['nome']} enable row level security;")
    for p in (t['politicas'] or []):
        s = f"create policy {p['nome']} on public.{t['nome']} as {p['permissiva'].lower()} for {p['cmd'].lower()} to {', '.join(p['papeis'])}"
        if p['usando']:
            s += f"\n  using ({p['usando']})"
        if p['checando']:
            s += f"\n  with check ({p['checando']})"
        out.append(s + ';')
    for papel, privs in sorted((t.get('concessoes') or {}).items()):
        out.append(f"-- concessão a {papel}: {privs}")
    return '\n'.join(out)


def gerar_estrutura(e):
    b = ['-- RETRATO DA ESTRUTURA DO BANCO DE PRODUÇÃO (projeto webchat-atendimento). GERADO: não editar à mão.',
         f"-- Tirado em {e['gerado_em']} · Postgres {e['versao_pg']}. Só estrutura: nenhuma linha de tabela, nenhum valor de configuração.",
         '-- Serve de referência e para os testes. NÃO rodar inteiro sobre a produção. Como refazer: supabase/producao/LEIAME.md.', '']
    b.append('-- ===== Extensões =====')
    b += [f"-- {x['nome']} {x['versao']} (esquema {x['esquema']})" for x in e['extensoes']]
    b.append('\n-- ===== Limite de tempo por papel =====')
    b += [f"-- {x['papel']}: {', '.join(x['config'] or ['sem limite'])}" for x in e['limites']]
    b.append(f"\n-- ===== Tabelas ({len(e['tabelas'])}) =====")
    for t in e['tabelas']:
        b += ['', sql_tabela(t)]
    b.append('\n-- ===== Chaves estrangeiras (depois de todas as tabelas) =====')
    for t in e['tabelas']:
        for k in (t['restricoes'] or []):
            if k['tipo'] == 'f':
                b.append(f"alter table public.{t['nome']} add constraint {k['nome']} {k['def']};")
    b.append(f"\n-- ===== Visões ({len(e['visoes'])}) =====")
    for v in e['visoes']:
        op = f" with ({', '.join(v['opcoes'])})" if v.get('opcoes') else ''
        b += ['', f"create {'materialized view' if v['tipo'] == 'm' else 'view'} public.{v['nome']}{op} as\n{v['def'].rstrip().rstrip(';')};"]
        b += [i + ';' for i in (v.get('indices') or [])]
        b += [f"-- concessão a {p}: {x}" for p, x in sorted((v.get('concessoes') or {}).items())]
    b.append('\n-- ===== Gatilhos (as funções estão em funcoes/) =====')
    for t in e['tabelas']:
        b += [g + ';' for g in (t['gatilhos'] or [])]
    b.append('\n-- ===== Tabelas publicadas no tempo real (postgres_changes) =====')
    b += [f"-- {x}" for x in (e['tempo_real'] or [])]
    b.append(f"\n-- ===== Rotinas agendadas (pg_cron): {len(e['rotinas'])} =====")
    for r in e['rotinas']:
        b.append(f"-- {r['nome']} · {r['quando']} · {'ativa' if r['ativa'] else 'PARADA'}\n--   " + re.sub(r'\s+', ' ', r['comando']).strip())
    b.append('\n-- ===== Chaves existentes em public.config (só os nomes; os valores não são copiados) =====')
    b.append('-- ' + ', '.join(e['config_chaves']))
    return '\n'.join(b) + '\n'


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    funcoes = json.load(open(sys.argv[1], encoding='utf-8'))
    estrutura = json.load(open(sys.argv[2], encoding='utf-8'))
    conferir_privacidade(json.dumps(funcoes, ensure_ascii=False) + json.dumps(estrutura, ensure_ascii=False))
    indice = gerar_funcoes(funcoes)
    with open(os.path.join(AQUI, 'estrutura.sql'), 'w', encoding='utf-8') as arq:
        arq.write(gerar_estrutura(estrutura))
    resumo = {
        'gerado_em': estrutura['gerado_em'], 'postgres': estrutura['versao_pg'],
        'tabelas': [{'nome': t['nome'], 'colunas': [c['nome'] for c in t['colunas']], 'rls': t['rls'], 'politicas': len(t['politicas'] or [])} for t in estrutura['tabelas']],
        'visoes': [v['nome'] for v in estrutura['visoes']],
        'rotinas': [{'nome': r['nome'], 'quando': r['quando'], 'ativa': r['ativa'], 'comando': re.sub(r'\s+', ' ', r['comando']).strip()} for r in estrutura['rotinas']],
        'gatilhos': sorted({g for t in estrutura['tabelas'] for g in (t['gatilhos'] or [])}),
        'tempo_real': estrutura['tempo_real'], 'config_chaves': estrutura['config_chaves'],
        'funcoes': indice,
    }
    with open(os.path.join(AQUI, 'indice.json'), 'w', encoding='utf-8') as arq:
        json.dump(resumo, arq, ensure_ascii=False, indent=1)
        arq.write('\n')
    print(f"{len(indice)} funções, {len(estrutura['tabelas'])} tabelas, {len(estrutura['visoes'])} visões, {len(estrutura['rotinas'])} rotinas -> {AQUI}")


if __name__ == '__main__':
    main()
