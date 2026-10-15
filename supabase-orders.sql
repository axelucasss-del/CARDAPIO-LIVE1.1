-- GAMAA / CARDÁPIO DIGITAL: Tabela de Pedidos (Orders) e Integração Mercado Pago
-- Execute este script no SQL Editor do Supabase para ativar o sistema de pedidos e o Pix Automático.

CREATE TABLE IF NOT EXISTS public.orders (
  id BIGSERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  delivery_type TEXT NOT NULL DEFAULT 'delivery', -- 'delivery' ou 'retirada'
  delivery_address TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  payment_method TEXT NOT NULL DEFAULT 'pix_mercadopago',
  payment_status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente', 'pago', 'cancelado'
  mercadopago_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'recebido', -- 'recebido', 'preparo', 'entrega', 'concluido', 'cancelado'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ativar Row Level Security
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Qualquer cliente anônimo ou autenticado pode criar pedidos (INSERT)
DROP POLICY IF EXISTS "Public can insert orders" ON public.orders;
CREATE POLICY "Public can insert orders"
ON public.orders FOR INSERT TO anon, authenticated
WITH CHECK (TRUE);

-- Qualquer cliente pode consultar o seu próprio pedido pelo ID (para checar status)
DROP POLICY IF EXISTS "Public can view own orders" ON public.orders;
CREATE POLICY "Public can view own orders"
ON public.orders FOR SELECT TO anon, authenticated
USING (TRUE);

-- Administradores autenticados podem ver, atualizar e excluir todos os pedidos
DROP POLICY IF EXISTS "Authenticated can manage orders" ON public.orders;
CREATE POLICY "Authenticated can manage orders"
ON public.orders FOR ALL TO authenticated
USING (TRUE) WITH CHECK (TRUE);

-- Liberar permissões de SELECT e INSERT para usuários anônimos
GRANT SELECT, INSERT ON public.orders TO anon;
GRANT ALL ON public.orders TO authenticated;

-- Habilitar Realtime para a tabela orders (para o painel de admin receber notificações instantâneas)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- ════════════════════════════════════════════════════════════
-- INTEGRAÇÃO MERCADO PAGO VIA SUPABASE RPC (SERVER-SIDE)
-- Faz a requisição pelo servidor do Supabase, eliminando o erro de CORS (Failed to fetch)
-- ════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.create_mercadopago_pix(
  p_amount numeric,
  p_description text,
  p_payer_email text,
  p_payer_name text,
  p_mp_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_url text := 'https://api.mercadopago.com/v1/payments';
  v_body text;
  v_response extensions.http_response;
  v_first_name text;
  v_last_name text;
  v_idempotency text;
  v_token text;
  v_res_json jsonb;
BEGIN
  v_token := trim(COALESCE(p_mp_token, ''));
  IF v_token = '' THEN
    RAISE EXCEPTION 'Access Token do Mercado Pago não configurado. Adicione no Painel Admin > Pagamentos.';
  END IF;

  v_first_name := split_part(trim(p_payer_name), ' ', 1);
  IF v_first_name = '' THEN v_first_name := 'Cliente'; END IF;
  
  v_last_name := substring(trim(p_payer_name) from length(v_first_name) + 2);
  IF v_last_name IS NULL OR trim(v_last_name) = '' THEN v_last_name := 'Digital'; END IF;

  v_idempotency := 'ord_' || floor(extract(epoch from now()) * 1000)::text || '_' || substr(md5(random()::text), 1, 6);

  v_body := json_build_object(
    'transaction_amount', round(p_amount, 2),
    'description', p_description,
    'payment_method_id', 'pix',
    'payer', json_build_object(
      'email', COALESCE(NULLIF(trim(p_payer_email), ''), 'cliente@cardapiodigital.com'),
      'first_name', v_first_name,
      'last_name', v_last_name
    )
  )::text;

  SELECT * INTO v_response
  FROM extensions.http((
    'POST',
    v_url,
    ARRAY[
      extensions.http_header('Authorization', 'Bearer ' || v_token),
      extensions.http_header('Content-Type', 'application/json'),
      extensions.http_header('X-Idempotency-Key', v_idempotency)
    ],
    'application/json',
    v_body
  ));

  IF v_response.status != 200 AND v_response.status != 201 THEN
    RAISE EXCEPTION 'Erro Mercado Pago (Status %): %', v_response.status, v_response.content;
  END IF;

  v_res_json := v_response.content::jsonb;
  RETURN v_res_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_mercadopago_status(
  p_payment_id text,
  p_mp_token text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_url text := 'https://api.mercadopago.com/v1/payments/' || trim(p_payment_id);
  v_response extensions.http_response;
  v_res_json jsonb;
  v_token text;
BEGIN
  v_token := trim(COALESCE(p_mp_token, ''));
  IF v_token = '' THEN RETURN NULL; END IF;

  SELECT * INTO v_response
  FROM extensions.http((
    'GET',
    v_url,
    ARRAY[
      extensions.http_header('Authorization', 'Bearer ' || v_token)
    ],
    NULL,
    NULL
  ));

  IF v_response.status = 200 THEN
    v_res_json := v_response.content::jsonb;
    RETURN v_res_json->>'status';
  END IF;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_mercadopago_pix TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_mercadopago_status TO anon, authenticated;
