-- public.conta_paciente_meus_dados()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_meus_dados()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                  declare
                    v_uid uuid := (select auth.uid()); v_cp public.contas_paciente;
                      v_cadastro jsonb; v_hist jsonb; v_pedidos jsonb; v_msgs jsonb; v_fotos int; v_conv int;
                      begin
                        select * into v_cp from public.contas_paciente where id = v_uid;
                          if v_uid is null or not found then raise exception 'Entre na sua conta para ver os seus dados.' using errcode = '42501'; end if;

                            select jsonb_build_object('nome', p.nome, 'data_nascimento', p.dt_nasc, 'cpf', p.cpf, 'email', p.email, 'telefones', to_jsonb(p.telefones),
                                                        'outros_dados', p.dados, 'criado_em', p.criado_em, 'ultima_visita_em', p.ultima_visita_em)
                                                            into v_cadastro from public.pacientes p where p.id = v_cp.paciente_id;

                                                              select coalesce(jsonb_agg(jsonb_build_object('quando', coalesce(h.ocorreu_em::timestamptz, h.criado_em), 'exames', h.exames, 'horarios', h.horarios,
                                                                                                             'convenio', h.plano, 'unidade', h.unidade, 'profissional', h.profissional, 'cancelado', h.cancelado)
                                                                                                                                        order by coalesce(h.ocorreu_em::timestamptz, h.criado_em) desc), '[]'::jsonb)
                                                                                                                                            into v_hist from public.paciente_historico h where h.paciente_id = v_cp.paciente_id;

                                                                                                                                              select coalesce(jsonb_agg(x.o order by x.criado desc), '[]'::jsonb) into v_pedidos from (
                                                                                                                                                  select c.criado_em as criado, jsonb_build_object(
                                                                                                                                                        'iniciado_em', c.criado_em,
                                                                                                                                                              'para', case when c.paciente_tipo = 'filho' then 'filho(a)' else 'a própria pessoa' end,
                                                                                                                                                                    'tipo', pa.tipo, 'situacao', pa.status,
                                                                                                                                                                          'exames', (select coalesce(jsonb_agg(coalesce(i.procedimento, i.modalidade) || coalesce(' (' || nullif(i.lado, 'N') || ')', '') order by i.id), '[]'::jsonb)
                                                                                                                                                                                             from public.pre_agendamento_itens i where i.conversa_id = c.id and i.ativo),
                                                                                                                                                                                                   'convenio', pa.plano, 'unidade', pa.unidade, 'profissional', pa.profissional, 'horarios', pa.escolha_horario,
                                                                                                                                                                                                         'dados_informados', pa.paciente) as o
                                                                                                                                                                                                             from public.conversas c left join public.pre_agendamentos pa on pa.conversa_id = c.id
                                                                                                                                                                                                                 where c.conta_id = v_uid order by c.criado_em desc limit 200) x;

                                                                                                                                                                                                                   select coalesce(jsonb_agg(jsonb_build_object('quando', m.criado_em, 'quem', case m.autor when 'cliente' then 'você' else 'clínica' end, 'texto', m.texto) order by m.criado_em, m.id), '[]'::jsonb)
                                                                                                                                                                                                                       into v_msgs from (
                                                                                                                                                                                                                             select m2.* from public.mensagens m2 join public.conversas c on c.id = m2.conversa_id
                                                                                                                                                                                                                                    where c.conta_id = v_uid and m2.autor in ('cliente', 'agente') order by m2.criado_em desc, m2.id desc limit 5000) m;

                                                                                                                                                                                                                                      select count(*) into v_fotos from public.conversa_anexo a join public.conversas c on c.id = a.conversa_id where c.conta_id = v_uid;
                                                                                                                                                                                                                                        select count(*) into v_conv from public.conversas where conta_id = v_uid;

                                                                                                                                                                                                                                          insert into public.conta_paciente_evento (tipo, tinha_cadastro, conversas) values ('copia', v_cp.paciente_id is not null, v_conv);

                                                                                                                                                                                                                                            return jsonb_build_object(
                                                                                                                                                                                                                                                'gerado_em', now(),
                                                                                                                                                                                                                                                    'conta', jsonb_build_object('email', v_cp.email, 'nome', v_cp.nome, 'telefone', v_cp.telefone, 'criada_em', v_cp.criado_em, 'aceitou_lgpd_em', v_cp.aceitou_lgpd_em),
                                                                                                                                                                                                                                                        'cadastro', v_cadastro, 'historico', v_hist, 'pedidos', v_pedidos, 'mensagens', v_msgs,
                                                                                                                                                                                                                                                            'fotos_de_pedido_guardadas', v_fotos,
                                                                                                                                                                                                                                                                'observacao', 'As fotos de pedido médico não vão neste arquivo; para recebê-las, fale com a clínica. Notas internas da equipe não fazem parte dos seus dados.');
                                                                                                                                                                                                                                                                end $function$;

