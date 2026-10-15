-- GAMAA BURGUER: banco de dados e Storage
-- Execute uma vez no Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.site_data (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  categories JSONB NOT NULL DEFAULT '{}'::jsonb,
  menu JSONB NOT NULL DEFAULT '{}'::jsonb,
  cat_order JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.site_data (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.site_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read menu" ON public.site_data;
CREATE POLICY "Public can read menu"
ON public.site_data FOR SELECT TO anon, authenticated
USING (id = 1);

DROP POLICY IF EXISTS "Authenticated can manage menu" ON public.site_data;
CREATE POLICY "Authenticated can manage menu"
ON public.site_data FOR ALL TO authenticated
USING (id = 1) WITH CHECK (id = 1);

GRANT SELECT ON public.site_data TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.site_data TO authenticated;

-- Buckets públicos: qualquer cliente pode visualizar as imagens/vídeos.
INSERT INTO storage.buckets (id, name, public)
VALUES ('cardapio-imagens', 'cardapio-imagens', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

INSERT INTO storage.buckets (id, name, public)
VALUES ('cardapio-videos', 'cardapio-videos', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

-- Políticas de leitura pública dos arquivos
DROP POLICY IF EXISTS "Public read cardapio imagens" ON storage.objects;
CREATE POLICY "Public read cardapio imagens"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'cardapio-imagens');

DROP POLICY IF EXISTS "Public read cardapio videos" ON storage.objects;
CREATE POLICY "Public read cardapio videos"
ON storage.objects FOR SELECT TO anon, authenticated
USING (bucket_id = 'cardapio-videos');

-- Upload, atualização e exclusão somente por usuários autenticados.
DROP POLICY IF EXISTS "Authenticated manage cardapio imagens" ON storage.objects;
CREATE POLICY "Authenticated manage cardapio imagens"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'cardapio-imagens')
WITH CHECK (bucket_id = 'cardapio-imagens');

DROP POLICY IF EXISTS "Authenticated manage cardapio videos" ON storage.objects;
CREATE POLICY "Authenticated manage cardapio videos"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'cardapio-videos')
WITH CHECK (bucket_id = 'cardapio-videos');
