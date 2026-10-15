-- GAMAA / CARDÁPIO DIGITAL: Cadastro de Clientes, Gestão e Privacidade de Pedidos
-- Execute este script no SQL Editor do Supabase.
-- ⚠️ Execute APÓS o script supabase-orders.sql.

-- ════════════════════════════════════════════════════════════
-- 1. EXTENSÃO PARA HASH CRIPTOGRÁFICO DE SENHAS (BCRYPT)
-- No Supabase, extensões ficam no schema "extensions"
-- ════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ════════════════════════════════════════════════════════════
-- 2. TABELA DE CLIENTES (CUSTOMERS)
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vincular customer_id na tabela orders caso ainda não exista
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN customer_id BIGINT REFERENCES public.customers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════
-- 3. ROW LEVEL SECURITY (RLS) & PERMISSÕES
-- ════════════════════════════════════════════════════════════
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can register customers" ON public.customers;
CREATE POLICY "Anyone can register customers"
ON public.customers FOR INSERT TO anon, authenticated
WITH CHECK (TRUE);

DROP POLICY IF EXISTS "Anyone can view customers" ON public.customers;
CREATE POLICY "Anyone can view customers"
ON public.customers FOR SELECT TO anon, authenticated
USING (TRUE);

GRANT SELECT, INSERT ON public.customers TO anon;
GRANT ALL ON public.customers TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.customers_id_seq TO anon, authenticated;

-- Garantir permissão de DELETE na tabela orders para autenticados
GRANT DELETE ON public.orders TO authenticated;

-- ════════════════════════════════════════════════════════════
-- 4. FUNÇÃO: CADASTRAR NOVO CLIENTE
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.register_customer(
  p_name TEXT,
  p_email TEXT,
  p_phone TEXT,
  p_password TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_customer public.customers;
BEGIN
  IF trim(COALESCE(p_name, '')) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Informe seu nome completo.');
  END IF;

  IF trim(COALESCE(p_email, '')) = '' OR p_email NOT LIKE '%@%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Informe um e-mail válido.');
  END IF;

  IF trim(COALESCE(p_password, '')) = '' OR length(p_password) < 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'A senha deve conter no mínimo 6 caracteres.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.customers WHERE lower(trim(email)) = lower(trim(p_email))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este e-mail já está cadastrado. Faça login com sua senha.');
  END IF;

  INSERT INTO public.customers (name, email, phone, password_hash)
  VALUES (
    trim(p_name),
    lower(trim(p_email)),
    trim(COALESCE(p_phone, '')),
    extensions.crypt(p_password, extensions.gen_salt('bf'))
  )
  RETURNING * INTO v_customer;

  -- Vincular retroativamente pedidos feitos anteriormente com este e-mail ou telefone
  UPDATE public.orders
  SET customer_id = v_customer.id
  WHERE customer_id IS NULL
    AND (
      (customer_email IS NOT NULL AND lower(trim(customer_email)) = lower(trim(v_customer.email)))
      OR (v_customer.phone <> '' AND regexp_replace(customer_phone, '\D', '', 'g') = regexp_replace(v_customer.phone, '\D', '', 'g'))
    );

  RETURN jsonb_build_object(
    'success', true,
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'name', v_customer.name,
      'email', v_customer.email,
      'phone', v_customer.phone
    )
  );
END;
$$;

-- ════════════════════════════════════════════════════════════
-- 5. FUNÇÃO: LOGIN DO CLIENTE
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.login_customer(
  p_email TEXT,
  p_password TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_customer public.customers;
BEGIN
  SELECT * INTO v_customer FROM public.customers
  WHERE lower(trim(email)) = lower(trim(p_email))
    AND password_hash = extensions.crypt(p_password, password_hash);

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'E-mail ou senha incorretos.');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'name', v_customer.name,
      'email', v_customer.email,
      'phone', v_customer.phone
    )
  );
END;
$$;

-- ════════════════════════════════════════════════════════════
-- 6. FUNÇÃO: BUSCAR TODOS OS PEDIDOS DO CLIENTE LOGADO
-- Retorna estritamente os pedidos pertencentes à conta do cliente
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_customer_orders(p_customer_id BIGINT)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_email TEXT;
  v_phone TEXT;
BEGIN
  IF p_customer_id IS NULL OR p_customer_id <= 0 THEN
    RETURN;
  END IF;

  SELECT email, phone INTO v_email, v_phone FROM public.customers WHERE id = p_customer_id;

  RETURN QUERY
  SELECT * FROM public.orders
  WHERE customer_id = p_customer_id
     OR (v_email IS NOT NULL AND v_email <> '' AND lower(trim(customer_email)) = lower(trim(v_email)))
     OR (v_phone IS NOT NULL AND v_phone <> '' AND regexp_replace(customer_phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g'))
  ORDER BY created_at DESC;
END;
$$;

-- ════════════════════════════════════════════════════════════
-- 6.1. FUNÇÃO DE PRIVACIDADE: BUSCAR PEDIDO ESPECÍFICO
-- Garante que um cliente SÓ POSSA VER O SEU PRÓPRIO PEDIDO!
-- Bloqueia expressamente qualquer acesso a pedidos de outros clientes.
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_customer_single_order(
  p_order_id BIGINT,
  p_customer_id BIGINT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_order public.orders;
  v_cust_email TEXT;
  v_cust_phone TEXT;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido não encontrado.');
  END IF;

  -- 1. Se cliente autenticado/logado
  IF p_customer_id IS NOT NULL AND p_customer_id > 0 THEN
    SELECT email, phone INTO v_cust_email, v_cust_phone FROM public.customers WHERE id = p_customer_id;
    IF v_order.customer_id = p_customer_id
       OR (v_cust_email IS NOT NULL AND v_cust_email <> '' AND lower(trim(v_order.customer_email)) = lower(trim(v_cust_email)))
       OR (v_cust_phone IS NOT NULL AND v_cust_phone <> '' AND regexp_replace(v_order.customer_phone, '\D', '', 'g') = regexp_replace(v_cust_phone, '\D', '', 'g')) THEN
      RETURN jsonb_build_object('success', true, 'order', to_jsonb(v_order));
    END IF;
  END IF;

  -- 2. Se cliente visitante comprou com telefone correspondente
  IF p_phone IS NOT NULL AND trim(p_phone) <> '' THEN
    IF regexp_replace(v_order.customer_phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g') THEN
      RETURN jsonb_build_object('success', true, 'order', to_jsonb(v_order));
    END IF;
  END IF;

  -- Bloqueio de segurança: impede que qualquer outro cliente veja o pedido
  RETURN jsonb_build_object('success', false, 'error', 'Você só tem permissão para visualizar os seus próprios pedidos.');
END;
$$;

-- ════════════════════════════════════════════════════════════
-- 7. FUNÇÃO: EXCLUIR PEDIDO FINALIZADO (ADMIN)
-- Permite excluir pedidos com status 'concluido' ou 'cancelado'
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.delete_order(p_order_id BIGINT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pedido #' || p_order_id || ' não encontrado.');
  END IF;

  IF v_status NOT IN ('concluido', 'cancelado') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Apenas pedidos concluídos ou cancelados podem ser excluídos.');
  END IF;

  DELETE FROM public.orders WHERE id = p_order_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ════════════════════════════════════════════════════════════
-- 8. FUNÇÃO: EXCLUIR TODOS OS PEDIDOS FINALIZADOS EM LOTE (ADMIN)
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.delete_all_finalized_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count INT;
BEGIN
  WITH deleted AS (
    DELETE FROM public.orders
    WHERE status IN ('concluido', 'cancelado')
    RETURNING *
  )
  SELECT count(*) INTO v_count FROM deleted;

  RETURN jsonb_build_object('success', true, 'count', v_count);
END;
$$;

-- ════════════════════════════════════════════════════════════
-- 9. PERMISSÕES DE EXECUÇÃO
-- ════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION public.register_customer TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_customer TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_orders TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_single_order TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_order TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_all_finalized_orders TO anon, authenticated;
