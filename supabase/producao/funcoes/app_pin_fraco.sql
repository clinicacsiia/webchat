-- public.app_pin_fraco(p_pin text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pin_fraco(p_pin text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select coalesce(p_pin ~ '^([0-9])\1{3}$'                                   -- 0000, 1111, ..., 9999
      or p_pin in ('0123', '1234', '2345', '3456', '4567', '5678', '6789', '3210', '4321', '5432', '6543', '7654', '8765', '9876')
      or p_pin ~ '^([0-9])([0-9])\1\2$'                                       -- 1212, 3434, ...
      or p_pin ~ '^([0-9])\1([0-9])\2$', false)                               -- 1122, 3344, ...
$function$;

