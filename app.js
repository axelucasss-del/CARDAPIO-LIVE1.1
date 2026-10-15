/* ============================================================
   GAMAA BURGUER – APP.JS  |  Data layer + theme engine
   ============================================================ */

const STORAGE_MENU   = 'gamaa_menu';
const STORAGE_CONFIG = 'gamaa_config';
const STORAGE_CATS   = 'gamaa_categories';
const STORAGE_CAT_ORDER = 'gamaa_cat_order';

/* ─── SUPABASE REMOTE PERSISTENCE ─────────────────────────── */
let gamaaSupabase = null;
let _remoteReady = false;
let _remoteSaveTimer = null;
let _remoteLoadInProgress = false;
let _remoteSubscription = null;
const REMOTE_TABLE = 'site_data';
const REMOTE_ID = 1;

function getSupabaseClient() {
  if (gamaaSupabase) return gamaaSupabase;
  let url = (window.GAMAA_SUPABASE_URL || '').trim();
  url = url.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  const key = (window.GAMAA_SUPABASE_KEY || '').trim();
  if (!window.supabase || !url.startsWith('https://') || !key || key.startsWith('COLE_AQUI')) return null;
  gamaaSupabase = window.supabase.createClient(url, key);
  return gamaaSupabase;
}

function readLocalSnapshot() {
  return {
    id: REMOTE_ID,
    config: JSON.parse(localStorage.getItem(STORAGE_CONFIG) || 'null') || { ...DEFAULT_CONFIG },
    categories: JSON.parse(localStorage.getItem(STORAGE_CATS) || 'null') || deepClone(DEFAULT_CATEGORIES),
    menu: JSON.parse(localStorage.getItem(STORAGE_MENU) || 'null') || {},
    cat_order: JSON.parse(localStorage.getItem(STORAGE_CAT_ORDER) || 'null') || [...DEFAULT_CAT_ORDER],
    updated_at: new Date().toISOString()
  };
}

function writeLocalSnapshot(row) {
  if (row.config && Object.keys(row.config).length) localStorage.setItem(STORAGE_CONFIG, JSON.stringify(row.config));
  if (row.categories && Object.keys(row.categories).length) localStorage.setItem(STORAGE_CATS, JSON.stringify(row.categories));
  if (row.menu && Object.keys(row.menu).length) localStorage.setItem(STORAGE_MENU, JSON.stringify(row.menu));
  if (Array.isArray(row.cat_order) && row.cat_order.length) localStorage.setItem(STORAGE_CAT_ORDER, JSON.stringify(row.cat_order));
}

async function persistRemoteState(showErrors = false) {
  const client = getSupabaseClient();
  if (!client || !_remoteReady) return;
  const snapshot = readLocalSnapshot();
  const { error } = await client.from(REMOTE_TABLE).upsert(snapshot, { onConflict: 'id' });
  if (error) {
    console.error('Erro ao salvar no Supabase:', error);
    if (showErrors && typeof showToast === 'function') showToast('Não foi possível salvar online. Confira o login e as políticas do Supabase.', 'error');
    return false;
  }
  return true;
}

function scheduleRemoteSave() {
  if (!_remoteReady) return;
  clearTimeout(_remoteSaveTimer);
  _remoteSaveTimer = setTimeout(() => persistRemoteState(true), 350);
}

function subscribeToRemoteChanges() {
  const client = getSupabaseClient();
  if (!client || _remoteSubscription) return;
  _remoteSubscription = client.channel('gamaa-site-data-live')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: REMOTE_TABLE, filter: 'id=eq.1' }, async (payload) => {
      // Não recarrega o painel administrativo enquanto ele próprio salva alterações.
      if (sessionStorage.getItem('gamaa_admin') === '1') return;
      if (!payload.new) return;
      writeLocalSnapshot(payload.new);
      localStorage.setItem('gamaa_remote_hydrated', '1');
      location.reload();
    })
    .subscribe();
}

async function initializeRemotePersistence() {
  if (_remoteLoadInProgress) return;
  _remoteLoadInProgress = true;
  const client = getSupabaseClient();
  if (!client) {
    console.warn('Supabase não configurado. O site continuará usando armazenamento local até configurar supabase-config.js.');
    return;
  }
  try {
    const { data, error } = await client.from(REMOTE_TABLE).select('*').eq('id', REMOTE_ID).maybeSingle();
    if (error) throw error;
    const remoteHasData = data && data.menu && Object.keys(data.menu).length > 0;
    if (remoteHasData) {
      const localLooksDefault = !localStorage.getItem('gamaa_remote_hydrated');
      writeLocalSnapshot(data);
      localStorage.setItem('gamaa_remote_hydrated', '1');
      _remoteReady = true;
      subscribeToRemoteChanges();
      // Recarrega uma única vez para que as páginas existentes renderizem os dados remotos.
      if (localLooksDefault && !sessionStorage.getItem('gamaa_remote_reload')) {
        sessionStorage.setItem('gamaa_remote_reload', '1');
        location.reload();
        return;
      }
      sessionStorage.removeItem('gamaa_remote_reload');
    } else {
      // Primeira configuração: usa os dados locais atuais como carga inicial.
      const { error: saveError } = await client.from(REMOTE_TABLE).upsert(readLocalSnapshot(), { onConflict: 'id' });
      if (saveError) throw saveError;
      localStorage.setItem('gamaa_remote_hydrated', '1');
      _remoteReady = true;
      subscribeToRemoteChanges();
    }
  } catch (err) {
    console.error('Não foi possível sincronizar o cardápio com o Supabase:', err);
    _remoteLoadInProgress = false;
    // Não apaga dados locais quando o backend estiver indisponível ou sem políticas.
  }
}

async function deleteStoredAsset(publicUrl, bucket = 'cardapio-imagens') {
  try {
    const client = getSupabaseClient();
    if (!client || !publicUrl) return;
    const marker = `/storage/v1/object/public/${bucket}/`;
    const index = publicUrl.indexOf(marker);
    if (index < 0) return;
    const path = decodeURIComponent(publicUrl.slice(index + marker.length).split('?')[0]);
    if (path) {
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error) console.warn('Não foi possível remover arquivo do Storage:', error);
    }
  } catch (error) { console.warn('Falha ao remover arquivo do Storage:', error); }
}

function uploadDataUrlToStorage(dataUrl, folder = 'imagens') {
  return new Promise(async (resolve, reject) => {
    try {
      const client = getSupabaseClient();
      if (!client || !dataUrl || !dataUrl.startsWith('data:')) return resolve(dataUrl);
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
      const path = `${folder}/${crypto.randomUUID()}.${ext}`;
      const { error } = await client.storage.from('cardapio-imagens').upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
      if (error) throw error;
      const { data } = client.storage.from('cardapio-imagens').getPublicUrl(path);
      resolve(data.publicUrl);
    } catch (err) {
      console.error('Falha ao enviar imagem para o Storage:', err);
      reject('Não foi possível enviar a imagem online. Confirme o login e o bucket cardapio-imagens.');
    }
  });
}

/* ─── DEFAULTS ────────────────────────────────────────────── */

const DEFAULT_CONFIG = {
  siteName:      'CARDÁPIO',
  siteSub:       'DIGITAL',
  heroTag:       '🔥 O melhor da cidade',
  heroTitle:     '',
  heroHighlight: 'CARDÁPIO DIGITAL',
  heroSubtitle:  'Escolha sua categoria e monte o seu pedido perfeito.',
  instagram:     '',
  whatsapp:      '',
  primaryColor:  '#e8002d',
  accentColor:   '#ffc400',
  bgColor:       '#0d0d0d',
  cardColor:     '#1a1a1a',
  logoEmoji:     '🍔',
  logoImage:     '',
  heroBgImage:   '',
  footerText:    '© 2026 Cardápio Digital · Todos os direitos reservados',
  mpAccessToken: '',
  acceptPix:     true,
  acceptCard:    true,
  acceptCash:    true,
  deliveryZones: [
    { name: 'Centro', fee: '5,00' },
    { name: 'Bairro Alto', fee: '7,00' }
  ],
  deliveryFee:   '5,00',
};

const DEFAULT_CATEGORIES = {
  entradas:     { label:'Entradas',     icon:'🥗', description:'Aperitivos & petiscos irresistíveis para começar bem',         photo:'' },
  hamburgueres: { label:'Hambúrgueres', icon:'🍔', description:'Smash burgers artesanais com ingredientes selecionados',        photo:'' },
  combos:       { label:'Combos',       icon:'🍟', description:'Combinações especiais com o melhor custo-benefício',            photo:'' },
  sobremesas:   { label:'Sobremesas',   icon:'🍰', description:'Doces irresistíveis para encerrar com chave de ouro',           photo:'' },
  bebidas:      { label:'Bebidas',      icon:'🥤', description:'Refrescantes opções para acompanhar seu pedido',                photo:'' },
};

const DEFAULT_CAT_ORDER = ['entradas','hamburgueres','combos','sobremesas','bebidas'];

function getCatOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_CAT_ORDER));
    if (Array.isArray(saved) && saved.length > 0) return saved;
  } catch { /* ignore */ }
  return [...DEFAULT_CAT_ORDER];
}

function saveCatOrder(order) {
  try {
    localStorage.setItem(STORAGE_CAT_ORDER, JSON.stringify(order));
    scheduleRemoteSave();
  } catch (e) {
    console.error('Erro ao salvar ordem das categorias:', e);
    showToast('Aviso: Armazenamento cheio no navegador.', 'error');
  }
}

// Compatibilidade: CAT_ORDER como getter global dinâmico para não quebrar referências
if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, 'CAT_ORDER', {
      get() { return getCatOrder(); },
      configurable: true
    });
  } catch {
    window.CAT_ORDER = DEFAULT_CAT_ORDER;
  }
}

/* ─── SITE CONFIG ─────────────────────────────────────────── */

function getSiteConfig() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_CONFIG));
    return Object.assign({}, DEFAULT_CONFIG, s || {});
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveSiteConfig(data) {
  try {
    localStorage.setItem(STORAGE_CONFIG, JSON.stringify(data));
    scheduleRemoteSave();
  } catch (e) {
    console.error('Erro ao salvar configuração:', e);
    showToast('Aviso: Armazenamento cheio no navegador.', 'error');
  }
}

/* ─── DELIVERY ZONES (BAIRROS E TAXAS) ────────────────────── */

function getDeliveryZones() {
  const cfg = getSiteConfig();
  if (Array.isArray(cfg.deliveryZones) && cfg.deliveryZones.length > 0) {
    return cfg.deliveryZones;
  }
  return [
    { name: 'Centro', fee: '5,00' },
    { name: 'Bairro Alto', fee: '7,00' }
  ];
}

function saveDeliveryZones(zones) {
  const cfg = getSiteConfig();
  cfg.deliveryZones = zones;
  saveSiteConfig(cfg);
}

function getDeliveryFeeForBairro(bairroName) {
  const zones = getDeliveryZones();
  const found = zones.find(z => (z.name || '').trim().toLowerCase() === (bairroName || '').trim().toLowerCase());
  if (found && found.fee) {
    return parseFloat(String(found.fee).replace(',', '.')) || 0;
  }
  const cfg = getSiteConfig();
  return parseFloat(String(cfg.deliveryFee || '5,00').replace(',', '.')) || 0;
}

/* ─── CATEGORY CONFIG ─────────────────────────────────────── */

function getCategoryConfig() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_CATS));
    if (s && typeof s === 'object' && Object.keys(s).length > 0) {
      return s;
    }
  } catch { /* ignore */ }
  return deepClone(DEFAULT_CATEGORIES);
}

function saveCategoryConfig(data) {
  try {
    localStorage.setItem(STORAGE_CATS, JSON.stringify(data));
    scheduleRemoteSave();
  } catch (e) {
    console.error('Erro ao salvar categorias:', e);
    showToast('Aviso: Armazenamento cheio no navegador.', 'error');
  }
}

/* ─── MENU DATA ───────────────────────────────────────────── */

function getMenu() {
  try { return JSON.parse(localStorage.getItem(STORAGE_MENU)) || {}; }
  catch { return {}; }
}

function saveMenu(data) {
  try {
    localStorage.setItem(STORAGE_MENU, JSON.stringify(data));
    scheduleRemoteSave();
  } catch (e) {
    console.error('Erro ao salvar menu:', e);
    showToast('Aviso: Armazenamento cheio no navegador.', 'error');
  }
}

function getCategoryItems(cat) { return getMenu()[cat] || []; }

function saveCategoryItems(cat, items) {
  const m = getMenu();
  m[cat] = items;
  saveMenu(m);
}

/* ─── UTILS ───────────────────────────────────────────────── */

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

/* ─── THEME ENGINE ────────────────────────────────────────── */

function applyTheme(cfg) {
  if (!cfg) cfg = getSiteConfig();
  const root = document.documentElement;
  const primary  = cfg.primaryColor || '#e8002d';
  const accent   = cfg.accentColor  || '#ffc400';
  const bg       = cfg.bgColor      || '#0d0d0d';
  const card     = cfg.cardColor    || '#1a1a1a';

  root.style.setProperty('--primary',      primary);
  root.style.setProperty('--primary-dark', darkenHex(primary, 28));
  root.style.setProperty('--gold',         accent);
  root.style.setProperty('--bg',           bg);
  root.style.setProperty('--bg2',          lightenHex(bg, 5));
  root.style.setProperty('--bg3',          lightenHex(bg, 10));
  root.style.setProperty('--card',         card);
  root.style.setProperty('--border',       lightenHex(bg, 22));
  root.style.setProperty('--text',         isLight(bg) ? '#111' : '#f0f0f0');
  root.style.setProperty('--muted',        isLight(bg) ? '#555' : '#888');

  const rgb = hexToRgb(primary);
  if (rgb) root.style.setProperty('--primary-rgb', `${rgb.r},${rgb.g},${rgb.b}`);

  const acRgb = hexToRgb(accent);
  if (acRgb) root.style.setProperty('--accent-rgb', `${acRgb.r},${acRgb.g},${acRgb.b}`);
}

/* ─── COLOR UTILITIES ─────────────────────────────────────── */

function hexToRgb(hex) {
  const c = hex.replace('#','');
  if (c.length !== 6) return null;
  return { r:parseInt(c.slice(0,2),16), g:parseInt(c.slice(2,4),16), b:parseInt(c.slice(4,6),16) };
}

function rgbToHex(r,g,b) {
  return '#' + [r,g,b].map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
}

function darkenHex(hex, amt) {
  const c = hexToRgb(hex); if (!c) return hex;
  return rgbToHex(c.r - amt, c.g - amt, c.b - amt);
}

function lightenHex(hex, amt) {
  const c = hexToRgb(hex); if (!c) return hex;
  return rgbToHex(c.r + amt, c.g + amt, c.b + amt);
}

function isLight(hex) {
  const c = hexToRgb(hex); if (!c) return false;
  // Perceived brightness
  return (c.r * 299 + c.g * 587 + c.b * 114) / 1000 > 128;
}

/* ─── TOAST ───────────────────────────────────────────────── */

function showToast(msg, type = 'success') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const icon = type === 'success' ? 'fa-circle-check' : 'fa-circle-xmark';
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<i class="fa ${icon}"></i> <span>${msg}</span>`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateY(10px)'; }, 3000);
  setTimeout(() => t.remove(), 3400);
}

/* ─── VIDEO HELPERS ───────────────────────────────────────── */

function getEmbedUrl(url) {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?rel=0`;
  const vm = url.match(/vimeo\.com\/(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i)) return url;
  return null;
}

function buildVideoElement(url) {
  const embed = getEmbedUrl(url);
  if (!embed) return null;
  if (embed.includes('youtube') || embed.includes('vimeo')) {
    const el = document.createElement('iframe');
    el.src = embed;
    el.allowFullscreen = true;
    el.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    el.frameBorder = '0';
    return el;
  }
  const el = document.createElement('video');
  el.src = embed; el.controls = true; el.muted = true; el.loop = true; el.playsInline = true;
  return el;
}

/* ─── FORMAT PRICE ────────────────────────────────────────── */

function formatPrice(val) {
  if (!val && val !== 0) return '';
  const n = parseFloat(String(val).replace(',','.'));
  return isNaN(n) ? val : 'R$\u00a0' + n.toFixed(2).replace('.',',');
}

/* ─── INDEXEDDB – VIDEO STORAGE ───────────────────────────── */
// localStorage suporta apenas ~5MB. Vídeos MP4 podem ter centenas de MB.
// Armazenamos os blobs de vídeo no IndexedDB (sem limite prático de tamanho).

const _VIDEO_DB_NAME = 'gamaa_videos_db';
const _VIDEO_STORE   = 'videos';

function _openVideoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_VIDEO_DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_VIDEO_STORE, { keyPath: 'id' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveVideoToDb(id, blob) {
  const db = await _openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_VIDEO_STORE, 'readwrite');
    tx.objectStore(_VIDEO_STORE).put({ id, blob });
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

async function getVideoFromDb(id) {
  const db = await _openVideoDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(_VIDEO_STORE, 'readonly').objectStore(_VIDEO_STORE).get(id);
    req.onsuccess = e => resolve(e.target.result ? e.target.result.blob : null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteVideoFromDb(id) {
  if (!id) return;
  try {
    const db = await _openVideoDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(_VIDEO_STORE, 'readwrite');
      tx.objectStore(_VIDEO_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
    });
  } catch { /* ignora */ }
}

/**
 * Resolve a URL de vídeo definitiva de um item:
 * - item.videoDbId  → busca Blob no IndexedDB → cria ObjectURL temporário
 * - item.videoUrl   → usa getEmbedUrl (YouTube / Vimeo / .mp4 direto)
 * - nenhum          → null
 */
async function resolveVideoSrc(item) {
  if (item && item.videoDbId) {
    try {
      const blob = await getVideoFromDb(item.videoDbId);
      if (blob) return URL.createObjectURL(blob);
    } catch { /* segue */ }
  }
  return (item && item.videoUrl) ? (getEmbedUrl(item.videoUrl) || null) : null;
}

/* ─── IMAGE FILE READER (AUTO-COMPRESS & RESIZE VIA CANVAS) ─── */

function readImageFile(file, maxDimension = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(null); return; }

    const isImg = (file.type && file.type.startsWith('image/')) ||
                  /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name || '');
    if (!isImg) {
      reject('Arquivo selecionado não é uma imagem válida.');
      return;
    }

    // Accept images up to 25MB (smartphones / high-res cameras)
    if (file.size > 25 * 1024 * 1024) {
      reject('Imagem muito pesada (máximo 25MB).');
      return;
    }

    // Support legacy maxMB parameter (e.g. readImageFile(file, 1))
    if (typeof maxDimension === 'number' && maxDimension <= 50) {
      if (maxDimension <= 1) maxDimension = 600;
      else if (maxDimension >= 3) maxDimension = 1600;
      else maxDimension = 1200;
    }

    const reader = new FileReader();
    reader.onerror = () => reject('Erro ao ler arquivo de imagem.');
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject('Erro ao processar imagem.');
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // Resize proportionally if larger than maxDimension
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const isPng = (file.type === 'image/png') || /\.png$/i.test(file.name || '');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        if (!isPng) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);

        try {
          let dataUrl;
          if (isPng) {
            dataUrl = canvas.toDataURL('image/png');
            // If PNG is over 450KB, convert to compressed JPEG to preserve browser storage quota
            if (dataUrl.length > 450 * 1024) {
              const jCanvas = document.createElement('canvas');
              jCanvas.width = width;
              jCanvas.height = height;
              const jCtx = jCanvas.getContext('2d');
              jCtx.fillStyle = '#ffffff';
              jCtx.fillRect(0, 0, width, height);
              jCtx.drawImage(img, 0, 0, width, height);
              dataUrl = jCanvas.toDataURL('image/jpeg', quality);
            }
          } else {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          }
          resolve(dataUrl);
        } catch (err) {
          // Fallback to original DataURL if canvas export fails
          resolve(e.target.result);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ─── SEED DATA ───────────────────────────────────────────── */

(function seedIfEmpty() {
  const menu = getMenu();
  if (Object.keys(menu).length > 0) return;

  const seed = {
    entradas: [
      { id:generateId(), name:'Onion Rings', price:'18,90',
        description:'Anéis de cebola empanados e fritos na hora, crocantes por fora e macios por dentro. Servidos com molho especial da casa.',
        videoUrl:'', imageUrl:'', tags:['Veggie','Crocante'] },
      { id:generateId(), name:'Batata Frita Premium', price:'16,90',
        description:'Batata palito crocante temperada com ervas finas e alho tostado. Acompanha molho cheddar artesanal.',
        videoUrl:'', imageUrl:'', tags:['Clássico'] },
    ],
    hamburgueres: [
      { id:generateId(), name:'Smash Especial', price:'34,90',
        description:'Dois smash burgers 120g de blend especial, queijo cheddar americano, maionese defumada, picles artesanal e cebola caramelizada no brioche amanteigado.',
        videoUrl:'', imageUrl:'', tags:['Destaque','Smash'] },
      { id:generateId(), name:'Duplo Bacon', price:'42,90',
        description:'Dois smash burgers 120g, bacon crocante, queijo cheddar duplo, alface americana, tomate e molho barbecue defumado.',
        videoUrl:'', imageUrl:'', tags:['Bacon','Duplo'] },
    ],
    combos: [
      { id:generateId(), name:'Combo Especial', price:'49,90',
        description:'Smash Especial + Batata Frita Premium + Bebida à escolha (350ml). O combo mais pedido da casa!',
        videoUrl:'', imageUrl:'', tags:['Mais Pedido','Completo'] },
    ],
    sobremesas: [
      { id:generateId(), name:'Brownie com Sorvete', price:'22,90',
        description:'Brownie de chocolate meio amargo quentinho com bola de sorvete de creme e calda de chocolate belga.',
        videoUrl:'', imageUrl:'', tags:['Chocolate','Quente'] },
    ],
    bebidas: [
      { id:generateId(), name:'Refrigerante Lata', price:'8,90',
        description:'Coca-Cola, Guaraná Antarctica, Sprite ou Fanta Laranja. Lata 350ml gelada.',
        videoUrl:'', imageUrl:'', tags:['350ml'] },
      { id:generateId(), name:'Milk-shake Artesanal', price:'24,90',
        description:'Milk-shake cremoso nos sabores: Chocolate, Morango, Baunilha ou Ninho. 400ml.',
        videoUrl:'', imageUrl:'', tags:['Cremoso','400ml'] },
    ],
  };

  saveMenu(seed);
})();


// Sincroniza dados remotos após definir os dados padrão.
window.addEventListener('load', () => { initializeRemotePersistence(); });

/* ─── CART ENGINE ─────────────────────────────────────────── */
const STORAGE_CART = 'gamaa_cart';

function getCart() {
  try { return JSON.parse(localStorage.getItem(STORAGE_CART)) || []; }
  catch { return []; }
}

function saveCart(cart) {
  try {
    localStorage.setItem(STORAGE_CART, JSON.stringify(cart));
    window.dispatchEvent(new CustomEvent('cart_updated', { detail: cart }));
  } catch(e) { console.error('Erro ao salvar carrinho:', e); }
}

function addToCart(item, qty = 1, notes = '') {
  const cart = getCart();
  const existing = cart.find(c => c.id === item.id && (c.notes || '') === (notes || ''));
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({
      id: item.id,
      name: item.name,
      price: item.price,
      image: (Array.isArray(item.images) && item.images[0]) || item.imageUrl || '',
      qty: qty,
      notes: notes || ''
    });
  }
  saveCart(cart);
  showToast(`"${item.name}" adicionado ao pedido!`);
}

function updateCartItemQty(index, delta) {
  const cart = getCart();
  if (!cart[index]) return;
  cart[index].qty += delta;
  if (cart[index].qty <= 0) {
    cart.splice(index, 1);
  }
  saveCart(cart);
}

function removeCartItem(index) {
  const cart = getCart();
  if (!cart[index]) return;
  cart.splice(index, 1);
  saveCart(cart);
}

function clearCart() {
  saveCart([]);
}

function getCartSubtotal() {
  const cart = getCart();
  return cart.reduce((sum, item) => {
    const p = parseFloat(String(item.price).replace(',','.')) || 0;
    return sum + (p * item.qty);
  }, 0);
}

function getCartCount() {
  const cart = getCart();
  return cart.reduce((sum, item) => sum + (item.qty || 1), 0);
}

/* ─── MERCADO PAGO INTEGRATION (PIX AUTOMÁTICO) ──────────── */
function getMercadoPagoToken() {
  const cfg = getSiteConfig();
  return (cfg.mpAccessToken || window.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
}

async function createMercadoPagoPix(orderData) {
  const token = getMercadoPagoToken();
  if (!token) {
    throw new Error('Mercado Pago não configurado. Adicione o Access Token no Painel Admin > Pagamentos ou em supabase-config.js.');
  }

  const amount = parseFloat(orderData.total);
  if (!amount || amount <= 0) throw new Error('Valor inválido para o pagamento.');

  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase não conectado. Verifique supabase-config.js.');
  }

  // Executa pelo servidor do Supabase (elimina o erro de CORS 'Failed to fetch' do navegador)
  const { data, error } = await client.rpc('create_mercadopago_pix', {
    p_amount: Number(amount.toFixed(2)),
    p_description: `Pedido de ${orderData.customer_name}`,
    p_payer_email: (orderData.customer_email || 'cliente@cardapiodigital.com').trim(),
    p_payer_name: orderData.customer_name.trim(),
    p_mp_token: token
  });

  if (error) {
    console.error('Erro no Supabase RPC Mercado Pago:', error);
    let msg = error.message || 'Erro ao gerar Pix no Mercado Pago.';
    if (msg.includes('Unauthorized use of live credentials')) {
      msg = 'Mercado Pago: Suas credenciais de produção (APP_USR) ainda não foram ativadas no painel do Mercado Pago Developers. Ative a aplicação em "Ativar credenciais de produção" ou use o Access Token de teste (iniciado com TEST-) para testar agora.';
    } else if (msg.includes('create_mercadopago_pix') || error.code === 'PGRST202') {
      msg = 'Execute o script supabase-orders.sql atualizado no SQL Editor do Supabase para ativar a integração segura do Pix.';
    }
    throw new Error(msg);
  }

  if (!data) {
    throw new Error('Resposta vazia ao criar Pix no Mercado Pago.');
  }

  const txData = data.point_of_interaction?.transaction_data;
  return {
    paymentId: data.id,
    status: data.status,
    qrCodeText: txData?.qr_code || '',
    qrCodeBase64: txData?.qr_code_base64 || '',
    ticketUrl: txData?.ticket_url || ''
  };
}

async function checkMercadoPagoStatus(paymentId) {
  const token = getMercadoPagoToken();
  if (!token || !paymentId) return null;
  const client = getSupabaseClient();
  if (!client) return null;

  try {
    const { data, error } = await client.rpc('check_mercadopago_status', {
      p_payment_id: String(paymentId),
      p_mp_token: token
    });
    if (!error && data) return data;
  } catch (err) {
    console.warn('Erro ao verificar status MP:', err);
  }
  return null;
}

/* ─── ORDERS MANAGEMENT (SUPABASE) ───────────────────────── */
async function createSupabaseOrder(orderData) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Banco de dados Supabase não configurado.');

  const { data, error } = await client.from('orders').insert([orderData]).select().single();
  if (error) {
    console.error('Erro ao salvar pedido no Supabase:', error);
    throw new Error('Não foi possível gravar o pedido. Verifique se executou o script supabase-orders.sql no Supabase.');
  }
  if (data && data.id) {
    saveMyLocalOrder(data.id, data.customer_phone);
  }
  return data;
}

async function updateSupabaseOrderStatus(orderId, status, paymentStatus) {
  const client = getSupabaseClient();
  if (!client) return false;
  const updatePayload = {};
  if (status) updatePayload.status = status;
  if (paymentStatus) updatePayload.payment_status = paymentStatus;

  const { error } = await client.from('orders').update(updatePayload).eq('id', orderId);
  if (error) {
    console.error('Erro ao atualizar pedido:', error);
    return false;
  }
  return true;
}

async function fetchSupabaseOrders() {
  const client = getSupabaseClient();
  if (!client) return [];
  const { data, error } = await client.from('orders').select('*').order('created_at', { ascending: false });
  if (error) {
    console.error('Erro ao buscar pedidos:', error);
    return [];
  }
  return data || [];
}

/* ─── MODAL VISIBILITY / BODY LOCK HELPER ─────────────────── */
function syncModalOpenState() {
  const anyModalOpen = Array.from(document.querySelectorAll('.modal-backdrop'))
    .some(el => el.style.display && el.style.display !== 'none');
  if (anyModalOpen) {
    document.body.classList.add('modal-open');
  } else {
    document.body.classList.remove('modal-open');
  }
}

/* ─── LOCAL STORAGE HELPERS FOR ORDER PRIVACY ─────────────── */
function saveMyLocalOrder(orderId, phone) {
  try {
    const key = 'gamaa_my_orders_list';
    const current = JSON.parse(localStorage.getItem(key) || '[]');
    const existing = current.find(x => String(x.id) === String(orderId));
    if (!existing) {
      current.unshift({ id: String(orderId), phone: phone || '', created_at: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(current.slice(0, 50)));
    }
    localStorage.setItem('gamaa_last_order_id', String(orderId));
  } catch(e) { console.warn(e); }
}

function getMyLocalOrders() {
  try {
    return JSON.parse(localStorage.getItem('gamaa_my_orders_list') || '[]');
  } catch { return []; }
}

async function fetchSupabaseOrderById(orderId) {
  const client = getSupabaseClient();
  if (!client || !orderId) return null;

  // Se admin autenticado no painel, permite consulta direta
  if (sessionStorage.getItem('gamaa_admin') === '1') {
    const { data } = await client.from('orders').select('*').eq('id', Number(orderId)).maybeSingle();
    if (data) return data;
  }

  // Para clientes: validação estrita de privacidade via RPC
  const customer = getLoggedCustomer();
  const myOrders = getMyLocalOrders();
  const localMatch = myOrders.find(x => String(x.id) === String(orderId));
  const phoneParam = (localMatch && localMatch.phone) ? localMatch.phone : (customer ? customer.phone : null);
  const custIdParam = customer ? customer.id : null;

  try {
    const { data, error } = await client.rpc('get_customer_single_order', {
      p_order_id: Number(orderId),
      p_customer_id: custIdParam,
      p_phone: phoneParam
    });
    if (!error && data) {
      if (data.success && data.order) return data.order;
      if (!data.success && data.error) {
        return { unauthorized: true, error: data.error };
      }
    }
  } catch (e) {
    console.warn('Erro ao verificar permissão do pedido:', e);
  }

  // Fallback seguro: se é visitante e o ID está salvo no aparelho dele
  if (localMatch) {
    const { data } = await client.from('orders').select('*').eq('id', Number(orderId)).maybeSingle();
    if (data && localMatch.phone && regexpDigits(data.customer_phone) === regexpDigits(localMatch.phone)) {
      return data;
    }
  }

  return { unauthorized: true, error: 'Você só pode visualizar os pedidos realizados por você.' };
}

function regexpDigits(val) {
  return String(val || '').replace(/\D/g, '');
}

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER AUTH & SESSION (Cadastro / Login de Clientes)
   ═══════════════════════════════════════════════════════════════ */
const STORAGE_CUSTOMER = 'gamaa_customer';

function getLoggedCustomer() {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_CUSTOMER));
    return (c && c.id) ? c : null;
  } catch { return null; }
}

function saveCustomerSession(customer) {
  localStorage.setItem(STORAGE_CUSTOMER, JSON.stringify(customer));
  window.dispatchEvent(new CustomEvent('customer_changed'));
}

function logoutCustomer() {
  localStorage.removeItem(STORAGE_CUSTOMER);
  window.dispatchEvent(new CustomEvent('customer_changed'));
  showToast('Você saiu da sua conta.');
}

async function registerCustomer(name, email, phone, password) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Banco de dados não configurado. Verifique supabase-config.js.');
  const { data, error } = await client.rpc('register_customer', {
    p_name: name, p_email: email, p_phone: phone, p_password: password
  });
  if (error) {
    const msg = error.message || '';
    if (msg.includes('register_customer') || error.code === 'PGRST202') {
      throw new Error('Execute o script supabase-customers.sql no SQL Editor do Supabase para ativar o cadastro de clientes.');
    }
    throw new Error(msg || 'Erro ao cadastrar.');
  }
  if (!data || !data.success) throw new Error((data && data.error) || 'Erro ao cadastrar.');
  saveCustomerSession(data.customer);
  return data.customer;
}

async function loginCustomer(email, password) {
  const client = getSupabaseClient();
  if (!client) throw new Error('Banco de dados não configurado. Verifique supabase-config.js.');
  const { data, error } = await client.rpc('login_customer', {
    p_email: email, p_password: password
  });
  if (error) {
    const msg = error.message || '';
    if (msg.includes('login_customer') || error.code === 'PGRST202') {
      throw new Error('Execute o script supabase-customers.sql no SQL Editor do Supabase para ativar o login de clientes.');
    }
    throw new Error(msg || 'Erro ao fazer login.');
  }
  if (!data || !data.success) throw new Error((data && data.error) || 'Erro ao fazer login.');
  saveCustomerSession(data.customer);
  return data.customer;
}

async function fetchCustomerOrders(customerId) {
  const client = getSupabaseClient();
  if (!client) return [];
  const { data, error } = await client.rpc('get_customer_orders', { p_customer_id: customerId });
  if (error) { console.error('Erro ao buscar pedidos do cliente:', error); return []; }
  return data || [];
}

async function deleteSupabaseOrder(orderId) {
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const { data, error } = await client.rpc('delete_order', { p_order_id: Number(orderId) });
    if (!error && data) {
      if (data.success) return true;
      if (data.error) {
        showToast(data.error, 'error');
        return false;
      }
    }
  } catch (e) {
    console.warn('RPC delete_order não disponível, usando exclusão direta:', e);
  }

  // Fallback: delete direto na tabela (se admin autenticado)
  const { error } = await client.from('orders').delete().eq('id', Number(orderId));
  if (error) {
    console.error('Erro ao excluir pedido:', error);
    return false;
  }
  return true;
}

async function deleteFinalizedOrdersBatch() {
  const client = getSupabaseClient();
  if (!client) return 0;
  try {
    const { data, error } = await client.rpc('delete_all_finalized_orders');
    if (!error && data && data.success) return data.count || 0;
  } catch (e) {
    console.warn('RPC delete_all_finalized_orders falhou:', e);
  }

  // Fallback: delete direto de concluídos e cancelados
  const { data, error } = await client.from('orders').delete().in('status', ['concluido', 'cancelado']).select();
  if (error) {
    console.error('Erro ao excluir pedidos finalizados:', error);
    return 0;
  }
  return (data || []).length;
}

/* ═══════════════════════════════════════════════════════════════
   CUSTOMER UI (Injeção dinâmica de modais e botões)
   Chamado por initCustomerUI() nas páginas do site
   ═══════════════════════════════════════════════════════════════ */
function initCustomerUI() {
  const navLinks = document.querySelector('.nav-links');
  if (!navLinks || document.getElementById('customerHeaderBtn')) return;

  // Botão Acompanhar Pedido no header
  const trackBtn = document.createElement('a');
  trackBtn.href = '#';
  trackBtn.id = 'trackOrderHeaderBtn';
  trackBtn.className = 'nav-track-btn';
  trackBtn.title = 'Acompanhar seu pedido em tempo real';
  trackBtn.onclick = (e) => { e.preventDefault(); openOrderTrackerModal(); };
  trackBtn.innerHTML = `<i class="fa fa-motorcycle"></i> <span class="nav-btn-text">Acompanhar</span><span class="track-pulse-dot" id="trackPulseDot" style="display:none"></span>`;
  navLinks.appendChild(trackBtn);

  // Botão de conta no header
  const btn = document.createElement('a');
  btn.href = '#';
  btn.id = 'customerHeaderBtn';
  btn.className = 'customer-header-btn';
  btn.onclick = (e) => { e.preventDefault(); toggleCustomerDropdown(); };
  navLinks.appendChild(btn);

  // Dropdown de conta
  const dropdown = document.createElement('div');
  dropdown.id = 'customerDropdown';
  dropdown.className = 'customer-dropdown';
  dropdown.style.display = 'none';
  document.body.appendChild(dropdown);

  // Modal de login/cadastro
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="customerAuthModalBg" style="display:none" onclick="if(event.target===this)closeCustomerAuthModal()">
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <h3 id="custAuthTitle">ENTRAR NA <span>CONTA</span></h3>
          <button class="modal-close" onclick="closeCustomerAuthModal()"><i class="fa fa-xmark"></i></button>
        </div>
        <div class="modal-body">
          <div class="customer-auth-tabs">
            <button class="cust-tab-btn active" id="tabCustLogin" onclick="switchCustomerAuthTab('login')">Entrar</button>
            <button class="cust-tab-btn" id="tabCustRegister" onclick="switchCustomerAuthTab('register')">Criar Conta</button>
          </div>
          <div class="login-error" id="custAuthError" style="display:none"></div>

          <div id="custLoginForm">
            <div class="form-group"><label>E-mail</label><input type="email" id="custLoginEmail" placeholder="seu@email.com"/></div>
            <div class="form-group"><label>Senha</label><input type="password" id="custLoginPass" placeholder="••••••"/></div>
            <button class="btn-primary" style="width:100%;margin-top:8px" onclick="doCustomerLogin()"><i class="fa fa-right-to-bracket"></i> Entrar</button>
          </div>

          <div id="custRegisterForm" style="display:none">
            <div class="form-group"><label>Nome Completo *</label><input type="text" id="custRegName" placeholder="Seu nome completo"/></div>
            <div class="form-group"><label>E-mail *</label><input type="email" id="custRegEmail" placeholder="seu@email.com"/></div>
            <div class="form-group"><label>WhatsApp / Telefone</label><input type="tel" id="custRegPhone" placeholder="(11) 99999-9999"/></div>
            <div class="form-group"><label>Senha * (mínimo 6 caracteres)</label><input type="password" id="custRegPass" placeholder="••••••"/></div>
            <div class="form-group"><label>Confirmar Senha *</label><input type="password" id="custRegPassConfirm" placeholder="••••••"/></div>
            <button class="btn-primary" style="width:100%;margin-top:8px" onclick="doCustomerRegister()"><i class="fa fa-user-plus"></i> Criar Conta</button>
          </div>
        </div>
      </div>
    </div>
  `);

  // Modal de "Meus Pedidos"
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="myOrdersModalBg" style="display:none" onclick="if(event.target===this)closeMyOrdersModal()">
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <h3>MEUS <span>PEDIDOS</span></h3>
          <button class="modal-close" onclick="closeMyOrdersModal()"><i class="fa fa-xmark"></i></button>
        </div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          <div id="myOrdersList">
            <div style="text-align:center;padding:30px;color:var(--muted)">
              <i class="fa fa-spinner fa-spin" style="font-size:2rem"></i>
              <p>Carregando pedidos...</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `);

  // Modal de "Acompanhar Pedido em Tempo Real"
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="orderTrackerModalBg" style="display:none" onclick="if(event.target===this)closeOrderTrackerModal()">
      <div class="modal order-tracker-modal" style="max-width:580px">
        <div class="modal-header" style="flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="tracker-live-pill"><span class="live-dot"></span> AO VIVO</span>
            <h3 style="margin:0">ACOMPANHAR <span>PEDIDO</span></h3>
          </div>
          <button class="modal-close" onclick="closeOrderTrackerModal()"><i class="fa fa-xmark"></i></button>
        </div>
        <div class="modal-body" style="max-height:75vh;overflow-y:auto;padding:16px 20px">
          <div id="trackerOrderPicker" style="display:none;margin-bottom:14px"></div>
          <div id="trackerContent">
            <!-- Renderizado dinamicamente -->
          </div>
        </div>
      </div>
    </div>
  `);

  updateCustomerHeaderUI();
  checkActiveOrderPulse();
  window.addEventListener('customer_changed', () => {
    updateCustomerHeaderUI();
    checkActiveOrderPulse();
  });

  // Enter para login
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const authModal = document.getElementById('customerAuthModalBg');
      if (authModal && authModal.style.display !== 'none') {
        const loginForm = document.getElementById('custLoginForm');
        if (loginForm && loginForm.style.display !== 'none') doCustomerLogin();
        else doCustomerRegister();
      }
    }
  });
}

function updateCustomerHeaderUI() {
  const btn = document.getElementById('customerHeaderBtn');
  if (!btn) return;
  const customer = getLoggedCustomer();
  if (customer) {
    const firstName = customer.name.split(' ')[0];
    btn.innerHTML = `<i class="fa fa-user-check"></i> <span class="nav-btn-text">${firstName}</span>`;
    btn.title = `Logado como ${customer.name}`;
    btn.classList.add('logged-in');
  } else {
    btn.innerHTML = `<i class="fa fa-user"></i> <span class="nav-btn-text">Entrar</span>`;
    btn.title = 'Entrar ou Criar Conta';
    btn.classList.remove('logged-in');
  }
}

function toggleCustomerDropdown() {
  const customer = getLoggedCustomer();
  if (!customer) { openCustomerAuthModal(); return; }

  const dropdown = document.getElementById('customerDropdown');
  if (!dropdown) return;

  if (dropdown.style.display === 'none' || !dropdown.style.display) {
    const btn = document.getElementById('customerHeaderBtn');
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 8) + 'px';
    dropdown.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
    dropdown.innerHTML = `
      <div class="cust-dropdown-header">
        <i class="fa fa-user-circle" style="font-size:1.5rem;color:var(--primary)"></i>
        <div>
          <strong style="color:var(--text)">${customer.name}</strong>
          <small style="display:block;color:var(--muted)">${customer.email}</small>
        </div>
      </div>
      <button class="cust-dropdown-item" onclick="openOrderTrackerModal();closeCustomerDropdown()">
        <i class="fa fa-motorcycle" style="color:var(--primary)"></i> Acompanhar Pedido
      </button>
      <button class="cust-dropdown-item" onclick="openMyOrdersModal();closeCustomerDropdown()">
        <i class="fa fa-receipt"></i> Meus Pedidos
      </button>
      <button class="cust-dropdown-item" style="color:#ef4444" onclick="logoutCustomer();closeCustomerDropdown()">
        <i class="fa fa-right-from-bracket"></i> Sair da Conta
      </button>
    `;
    dropdown.style.display = 'block';
    setTimeout(() => document.addEventListener('click', _closeDropdownOutside), 10);
  } else {
    closeCustomerDropdown();
  }
}

function _closeDropdownOutside(e) {
  const dd = document.getElementById('customerDropdown');
  const btn = document.getElementById('customerHeaderBtn');
  if (dd && !dd.contains(e.target) && btn && !btn.contains(e.target)) closeCustomerDropdown();
}

function closeCustomerDropdown() {
  const dropdown = document.getElementById('customerDropdown');
  if (dropdown) dropdown.style.display = 'none';
  document.removeEventListener('click', _closeDropdownOutside);
}

/* ── Modal de Login / Cadastro ── */
function openCustomerAuthModal() {
  closeCustomerDropdown();
  switchCustomerAuthTab('login');
  const errBox = document.getElementById('custAuthError');
  if (errBox) errBox.style.display = 'none';
  // Limpar campos
  ['custLoginEmail','custLoginPass','custRegName','custRegEmail','custRegPhone','custRegPass','custRegPassConfirm'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('customerAuthModalBg').style.display = 'flex';
  syncModalOpenState();
  setTimeout(() => {
    const el = document.getElementById('custLoginEmail');
    if (el) el.focus();
  }, 80);
}

function closeCustomerAuthModal() {
  document.getElementById('customerAuthModalBg').style.display = 'none';
  syncModalOpenState();
}

function switchCustomerAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tabCustLogin').classList.toggle('active', isLogin);
  document.getElementById('tabCustRegister').classList.toggle('active', !isLogin);
  document.getElementById('custLoginForm').style.display = isLogin ? '' : 'none';
  document.getElementById('custRegisterForm').style.display = isLogin ? 'none' : '';
  document.getElementById('custAuthTitle').innerHTML = isLogin ? 'ENTRAR NA <span>CONTA</span>' : 'CRIAR <span>CONTA</span>';
  document.getElementById('custAuthError').style.display = 'none';
}

async function doCustomerLogin() {
  const email = document.getElementById('custLoginEmail').value.trim();
  const pass = document.getElementById('custLoginPass').value;
  const errBox = document.getElementById('custAuthError');
  if (!email) { errBox.textContent = 'Informe seu e-mail.'; errBox.style.display = 'block'; return; }
  if (!pass) { errBox.textContent = 'Informe sua senha.'; errBox.style.display = 'block'; return; }
  try {
    const customer = await loginCustomer(email, pass);
    closeCustomerAuthModal();
    showToast(`Bem-vindo(a), ${customer.name}!`);
    autoFillCustomerCheckout();
  } catch(e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  }
}

async function doCustomerRegister() {
  const name = document.getElementById('custRegName').value.trim();
  const email = document.getElementById('custRegEmail').value.trim();
  const phone = document.getElementById('custRegPhone').value.trim();
  const pass = document.getElementById('custRegPass').value;
  const passConfirm = document.getElementById('custRegPassConfirm').value;
  const errBox = document.getElementById('custAuthError');
  if (!name) { errBox.textContent = 'Informe seu nome.'; errBox.style.display = 'block'; return; }
  if (!email) { errBox.textContent = 'Informe seu e-mail.'; errBox.style.display = 'block'; return; }
  if (!pass || pass.length < 6) { errBox.textContent = 'A senha deve ter pelo menos 6 caracteres.'; errBox.style.display = 'block'; return; }
  if (pass !== passConfirm) { errBox.textContent = 'As senhas não coincidem.'; errBox.style.display = 'block'; return; }
  try {
    const customer = await registerCustomer(name, email, phone, pass);
    closeCustomerAuthModal();
    showToast(`Conta criada! Bem-vindo(a), ${customer.name}!`);
    autoFillCustomerCheckout();
  } catch(e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  }
}

function autoFillCustomerCheckout() {
  const customer = getLoggedCustomer();
  const banner = document.getElementById('checkoutCustomerBanner');
  const elName = document.getElementById('custName');
  const elPhone = document.getElementById('custPhone');
  const elEmail = document.getElementById('custEmail');

  if (customer) {
    if (elName) elName.value = customer.name;
    if (elPhone && customer.phone) elPhone.value = customer.phone;
    if (elEmail) elEmail.value = customer.email;
    if (banner) {
      banner.className = 'checkout-cust-banner logged';
      banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <i class="fa fa-user-check" style="color:#22c55e"></i>
          <span>Logado como <strong>${customer.name}</strong> (${customer.email})</span>
        </div>
        <button type="button" class="btn-text-action" onclick="logoutCustomer();autoFillCustomerCheckout()" title="Sair desta conta">Trocar conta</button>
      `;
      banner.style.display = 'flex';
    }
  } else {
    if (banner) {
      banner.className = 'checkout-cust-banner unlogged';
      banner.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <i class="fa fa-circle-user" style="color:var(--gold)"></i>
          <span>Já tem conta? Entre para preencher tudo rápido!</span>
        </div>
        <button type="button" class="btn-text-action highlight" onclick="openCustomerAuthModal()">Fazer login</button>
      `;
      banner.style.display = 'flex';
    }
  }
}

/* ── Modal Meus Pedidos ── */
async function openMyOrdersModal() {
  const customer = getLoggedCustomer();
  const modal = document.getElementById('myOrdersModalBg');
  if (modal) modal.style.display = 'flex';
  syncModalOpenState();

  const list = document.getElementById('myOrdersList');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)"><i class="fa fa-spinner fa-spin" style="font-size:2rem"></i><p>Carregando seus pedidos...</p></div>';

  let orders = [];
  if (customer) {
    orders = await fetchCustomerOrders(customer.id);
  } else {
    // Busca os pedidos locais deste visitante
    const local = getMyLocalOrders();
    for (const item of local) {
      try {
        const o = await fetchSupabaseOrderById(item.id);
        if (o && !o.unauthorized) orders.push(o);
      } catch(e) {}
    }
  }

  if (!orders.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--muted)">
        <i class="fa fa-receipt" style="font-size:2.5rem;margin-bottom:12px;display:block"></i>
        <h3 style="color:var(--text);margin-bottom:8px">Nenhum pedido ainda</h3>
        <p>${customer ? 'Seus pedidos aparecerão aqui depois que você fizer o primeiro.' : 'Você não possui pedidos registrados neste aparelho. Faça login para ver pedidos da sua conta ou faça um novo pedido!'}</p>
        ${!customer ? '<button class="btn-primary" style="margin-top:14px;padding:8px 18px;font-size:.85rem" onclick="closeMyOrdersModal();openCustomerAuthModal()"><i class="fa fa-user"></i> Entrar na Conta</button>' : ''}
      </div>`;
    return;
  }

  const statusMap = {
    recebido:  { label: '🟡 Recebido',       class: 'state-recebido' },
    preparo:   { label: '🔵 Em Preparo',      class: 'state-preparo' },
    entrega:   { label: '🟣 Saiu p/ Entrega', class: 'state-entrega' },
    concluido: { label: '🟢 Concluído',       class: 'state-concluido' },
    cancelado: { label: '🔴 Cancelado',       class: 'state-cancelado' }
  };

  list.innerHTML = orders.map(order => {
    const st = statusMap[order.status] || { label: order.status, class: '' };
    const isPaid = order.payment_status === 'pago';
    const dateStr = _formatCustOrderDate(order.created_at);
    const itemsList = (Array.isArray(order.items) ? order.items : [])
      .map(it => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.85rem"><span style="color:var(--text)">${it.qty}x ${it.name}</span><span style="color:var(--gold)">${formatPrice((parseFloat(String(it.price).replace(',','.'))||0)*(it.qty||1))}</span></div>`)
      .join('');

    const payMap = {
      pix_mercadopago:  'Pix',
      cartao_entrega:   'Cartão na entrega',
      dinheiro_entrega: 'Dinheiro na entrega'
    };
    const payLabel = payMap[order.payment_method] || order.payment_method || 'Pix';
    const isDelivery = order.delivery_type === 'delivery';

    return `
      <div class="my-order-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px">
          <div>
            <span style="font-weight:700;font-size:1.1rem;color:var(--text)">Pedido #${order.id}</span>
            <span style="font-size:.8rem;color:var(--muted);margin-left:8px"><i class="fa fa-clock"></i> ${dateStr}</span>
          </div>
          <span class="status-pill ${st.class}" style="font-size:.75rem">${st.label}</span>
        </div>
        <div style="font-size:.8rem;color:var(--muted);margin-bottom:8px;display:flex;flex-direction:column;gap:3px">
          <div><i class="fa ${isDelivery ? 'fa-location-dot' : 'fa-store'}" style="color:var(--primary);margin-right:4px"></i> <strong>${isDelivery ? 'Entrega:' : 'Retirada:'}</strong> ${isDelivery ? (order.delivery_address || 'Endereço padrão') : 'Balcão da loja'}</div>
          <div><i class="fa fa-credit-card" style="margin-right:4px"></i> <strong>Pagamento:</strong> ${payLabel}</div>
        </div>
        <div style="background:var(--bg3);border-radius:8px;padding:10px;margin-bottom:10px">
          ${itemsList}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:10px;border-top:1px dashed var(--border);flex-wrap:wrap;gap:8px">
          <span style="font-size:.85rem;color:var(--muted)">
            ${isPaid ? '<span style="color:#22c55e;font-weight:600"><i class="fa fa-check"></i> Pago</span>' : '<span style="color:#eab308;font-weight:600"><i class="fa fa-hourglass-half"></i> Pagamento pendente</span>'}
          </span>
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-weight:700;font-size:1.15rem;color:var(--gold)">${formatPrice(order.total)}</span>
            <button type="button" class="btn-track-mini ${order.status!=='concluido'&&order.status!=='cancelado'?'active':''}" onclick="closeMyOrdersModal();openOrderTrackerModal('${order.id}')">
              <i class="fa fa-motorcycle"></i> ${order.status!=='concluido'&&order.status!=='cancelado'?'Acompanhar ao Vivo':'Detalhes'}
            </button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function _formatCustOrderDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hrs = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${mon}/${year} às ${hrs}:${min}`;
  } catch { return isoStr; }
}

function closeMyOrdersModal() {
  document.getElementById('myOrdersModalBg').style.display = 'none';
  syncModalOpenState();
}

/* ═══════════════════════════════════════════════════════════════
   ORDER TRACKER (Acompanhamento de Pedido em Tempo Real)
   ═══════════════════════════════════════════════════════════════ */
let _activeTrackerOrderId = null;
let _trackerRealtimeChannel = null;
let _trackerPollingTimer = null;

async function checkActiveOrderPulse() {
  const lastId = localStorage.getItem('gamaa_last_order_id');
  const dot = document.getElementById('trackPulseDot');
  if (!lastId) {
    if (dot) dot.style.display = 'none';
    return;
  }
  const order = await fetchSupabaseOrderById(lastId);
  if (order && order.status !== 'concluido' && order.status !== 'cancelado') {
    if (dot) dot.style.display = 'inline-block';
    renderFloatingTrackerPill(order);
  } else {
    if (dot) dot.style.display = 'none';
    removeFloatingTrackerPill();
  }
}

function renderFloatingTrackerPill(order) {
  let pill = document.getElementById('floatingOrderPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'floatingOrderPill';
    pill.className = 'floating-order-pill';
    document.body.appendChild(pill);
  }

  const statusTexts = {
    recebido: '🟡 Pedido Recebido',
    preparo:  '🔥 Em Produção',
    entrega:  '🛵 Saiu p/ Entrega'
  };
  const stText = statusTexts[order.status] || 'Acompanhar Pedido';

  pill.innerHTML = `
    <div class="f-pill-icon"><i class="fa fa-motorcycle"></i></div>
    <div class="f-pill-info">
      <strong>Pedido #${order.id}</strong>
      <span>${stText}</span>
    </div>
    <button type="button" class="f-pill-btn" onclick="openOrderTrackerModal('${order.id}')">Ver <i class="fa fa-chevron-right"></i></button>
  `;
}

function removeFloatingTrackerPill() {
  const pill = document.getElementById('floatingOrderPill');
  if (pill) pill.remove();
}

async function openOrderTrackerModal(orderId) {
  const modal = document.getElementById('orderTrackerModalBg');
  if (!modal) return;
  modal.style.display = 'flex';
  syncModalOpenState();

  const pickerWrap = document.getElementById('trackerOrderPicker');
  const wrap = document.getElementById('trackerContent');

  // Obter pedidos pertencentes exclusivamente a este cliente
  const customer = getLoggedCustomer();
  let myOrders = [];
  if (customer) {
    try {
      myOrders = await fetchCustomerOrders(customer.id);
    } catch(e) { console.warn(e); }
  }
  const localOrders = getMyLocalOrders();

  // Unir sem duplicatas
  const allOrderIds = [];
  const combinedList = [];
  myOrders.forEach(o => {
    if (!allOrderIds.includes(String(o.id))) {
      allOrderIds.push(String(o.id));
      combinedList.push({ id: String(o.id), status: o.status, created_at: o.created_at });
    }
  });
  localOrders.forEach(lo => {
    if (!allOrderIds.includes(String(lo.id))) {
      allOrderIds.push(String(lo.id));
      combinedList.push({ id: String(lo.id), status: lo.status || 'recebido', created_at: lo.created_at });
    }
  });

  if (combinedList.length === 0 && !orderId) {
    if (pickerWrap) pickerWrap.style.display = 'none';
    if (wrap) {
      wrap.innerHTML = `
        <div style="text-align:center;padding:40px 20px;color:var(--muted)">
          <i class="fa fa-motorcycle" style="font-size:3rem;margin-bottom:12px;color:var(--primary);opacity:.8;display:block"></i>
          <h3 style="color:var(--text);margin-bottom:8px">Acompanhe seu Pedido</h3>
          <p style="font-size:.9rem;line-height:1.5">Você ainda não tem pedidos em andamento neste aparelho. Faça um pedido no cardápio para acompanhar a entrega em tempo real!</p>
        </div>
      `;
    }
    return;
  }

  let targetId = orderId || localStorage.getItem('gamaa_last_order_id') || (combinedList[0] && combinedList[0].id);

  // Se houver mais de um pedido do próprio cliente, renderiza seletor limpo
  if (combinedList.length > 1 && pickerWrap) {
    const statusLabels = {
      recebido: 'Recebido', preparo: 'Em Produção', entrega: 'A Caminho', concluido: 'Finalizado', cancelado: 'Cancelado'
    };
    pickerWrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:8px 12px">
        <label style="font-size:.82rem;font-weight:600;color:var(--muted);white-space:nowrap"><i class="fa fa-list"></i> Seus pedidos:</label>
        <select id="selectCustomerOrderPicker" style="flex:1;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:.84rem;cursor:pointer" onchange="loadAndRenderTracker(this.value)">
          ${combinedList.map(o => `
            <option value="${o.id}" ${String(o.id) === String(targetId) ? 'selected' : ''}>
              Pedido #${o.id} · ${statusLabels[o.status] || o.status} ${_formatCustOrderDate(o.created_at) ? '(' + _formatCustOrderDate(o.created_at) + ')' : ''}
            </option>
          `).join('')}
        </select>
      </div>
    `;
    pickerWrap.style.display = 'block';
  } else if (pickerWrap) {
    pickerWrap.style.display = 'none';
  }

  if (targetId) {
    await loadAndRenderTracker(targetId);
  }
}

function closeOrderTrackerModal() {
  const modal = document.getElementById('orderTrackerModalBg');
  if (modal) modal.style.display = 'none';
  syncModalOpenState();

  if (_trackerRealtimeChannel) {
    const client = getSupabaseClient();
    if (client) client.removeChannel(_trackerRealtimeChannel);
    _trackerRealtimeChannel = null;
  }
  clearInterval(_trackerPollingTimer);
  _trackerPollingTimer = null;
  _activeTrackerOrderId = null;
}

async function loadAndRenderTracker(orderId) {
  _activeTrackerOrderId = String(orderId);
  const wrap = document.getElementById('trackerContent');
  if (!wrap) return;

  wrap.innerHTML = `
    <div style="text-align:center;padding:40px;color:var(--muted)">
      <i class="fa fa-spinner fa-spin" style="font-size:2.2rem;color:var(--primary);margin-bottom:12px"></i>
      <p>Carregando status do pedido #${orderId}...</p>
    </div>
  `;

  const order = await fetchSupabaseOrderById(orderId);
  if (!order || order.unauthorized) {
    wrap.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--muted)">
        <i class="fa fa-lock" style="font-size:2.8rem;color:#ef4444;margin-bottom:14px;display:block"></i>
        <h3 style="color:var(--text);margin-bottom:8px">Acesso Restrito</h3>
        <p style="font-size:.9rem;line-height:1.5">${(order && order.error) || 'Você só pode visualizar os pedidos realizados por você.'}</p>
      </div>
    `;
    return;
  }

  localStorage.setItem('gamaa_last_order_id', order.id);
  renderTrackerData(order);
  subscribeTrackerRealtime(order.id);
}

function renderTrackerData(order) {
  const wrap = document.getElementById('trackerContent');
  if (!wrap) return;

  const cfg = getSiteConfig();
  const isDelivery = order.delivery_type === 'delivery';
  const isPaid = order.payment_status === 'pago';

  const payMap = {
    pix_mercadopago:  'Pix',
    cartao_entrega:   'Cartão na entrega',
    dinheiro_entrega: 'Dinheiro na entrega'
  };
  const payLabel = payMap[order.payment_method] || order.payment_method || 'Pix';

  // Configuração das 4 etapas
  const steps = [
    { key: 'recebido',  icon: 'fa-receipt',     title: 'Recebido',      desc: 'Confirmado no sistema' },
    { key: 'preparo',   icon: 'fa-fire-burner', title: 'Em Produção',   desc: 'Cozinhando com carinho' },
    { key: 'entrega',   icon: isDelivery ? 'fa-motorcycle' : 'fa-bag-shopping', title: isDelivery ? 'A Caminho' : 'Pronto', desc: isDelivery ? 'Entregador em rota' : 'Disponível no balcão' },
    { key: 'concluido', icon: 'fa-check',       title: 'Finalizado',    desc: 'Entregue com sucesso' }
  ];

  const statusOrder = ['recebido', 'preparo', 'entrega', 'concluido'];
  const currentIndex = statusOrder.indexOf(order.status);
  const isCancelled = order.status === 'cancelado';

  // Mensagem em destaque
  let highlightCard = '';
  if (isCancelled) {
    highlightCard = `
      <div class="tracker-msg-card cancelado">
        <i class="fa fa-ban" style="font-size:2rem"></i>
        <div>
          <h4>Pedido Cancelado</h4>
          <p>Este pedido foi cancelado pelo estabelecimento. Fale conosco pelo WhatsApp caso precise de ajuda.</p>
        </div>
      </div>
    `;
  } else if (order.status === 'recebido') {
    highlightCard = `
      <div class="tracker-msg-card recebido">
        <i class="fa fa-clock" style="font-size:2rem"></i>
        <div>
          <h4>Pedido Recebido!</h4>
          <p>Recebemos o seu pedido. A cozinha iniciará o preparo em instantes.</p>
        </div>
      </div>
    `;
  } else if (order.status === 'preparo') {
    highlightCard = `
      <div class="tracker-msg-card preparo">
        <i class="fa fa-fire" style="font-size:2rem"></i>
        <div>
          <h4>Em Produção!</h4>
          <p>Seus itens estão sendo preparados com capricho pela nossa equipe.</p>
        </div>
      </div>
    `;
  } else if (order.status === 'entrega') {
    highlightCard = `
      <div class="tracker-msg-card entrega">
        <i class="fa ${isDelivery ? 'fa-motorcycle' : 'fa-bag-shopping'}" style="font-size:2rem"></i>
        <div>
          <h4>${isDelivery ? 'Saiu para Entrega!' : 'Pronto para Retirada!'}</h4>
          <p>${isDelivery ? 'O entregador já está a caminho do seu endereço. Fique atento!' : 'Seu pedido já está pronto para ser retirado no balcão da loja!'}</p>
        </div>
      </div>
    `;
  } else if (order.status === 'concluido') {
    highlightCard = `
      <div class="tracker-msg-card concluido">
        <i class="fa fa-circle-check" style="font-size:2rem"></i>
        <div>
          <h4>Pedido Finalizado!</h4>
          <p>Seu pedido foi entregue com sucesso. Esperamos que goste e bom apetite!</p>
        </div>
      </div>
    `;
  }

  // Montagem do Stepper Visual
  const stepperHTML = isCancelled ? '' : `
    <div class="tracker-stepper">
      ${steps.map((st, idx) => {
        const isDone = currentIndex > idx;
        const isActive = currentIndex === idx;
        const stateClass = isDone ? 'completed' : (isActive ? 'active' : '');
        return `
          <div class="tracker-step ${stateClass}">
            <div class="t-step-circle">
              <i class="fa ${st.icon}"></i>
            </div>
            <div class="t-step-label">${st.title}</div>
            <div class="t-step-desc">${st.desc}</div>
          </div>
          ${idx < steps.length - 1 ? `<div class="tracker-line ${currentIndex > idx ? 'filled' : ''}"></div>` : ''}
        `;
      }).join('')}
    </div>
  `;

  // Itens do pedido
  const itemsList = (Array.isArray(order.items) ? order.items : [])
    .map(it => `
      <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:.85rem;border-bottom:1px dashed rgba(255,255,255,.05)">
        <span><strong style="color:var(--text)">${it.qty}x</strong> ${it.name} ${it.notes ? `<small style="display:block;color:var(--muted)">Obs: ${it.notes}</small>` : ''}</span>
        <span style="color:var(--gold);font-weight:600">${formatPrice((parseFloat(String(it.price).replace(',','.'))||0)*(it.qty||1))}</span>
      </div>
    `).join('');

  // WhatsApp de suporte
  const waClean = (cfg.whatsapp || '').replace(/\D/g, '');
  const waUrl = waClean
    ? `https://wa.me/${waClean}?text=${encodeURIComponent('Olá! Gostaria de falar sobre o meu pedido #' + order.id)}`
    : null;

  wrap.innerHTML = `
    <!-- Topo: número e data -->
    <div class="tracker-top-info">
      <div>
        <span class="tracker-order-num">Pedido #${order.id}</span>
        <span class="tracker-order-time"><i class="fa fa-clock"></i> ${_formatCustOrderDate(order.created_at)}</span>
      </div>
      <button type="button" class="btn-secondary" style="font-size:.78rem;padding:6px 12px" onclick="loadAndRenderTracker('${order.id}')" title="Atualizar dados agora">
        <i class="fa fa-rotate"></i> Atualizar
      </button>
    </div>

    <!-- Stepper animado de progresso -->
    ${stepperHTML}

    <!-- Card de destaque -->
    ${highlightCard}

    <!-- Detalhes de entrega e pagamento -->
    <div class="tracker-details-card">
      <div class="tracker-detail-row">
        <span><i class="fa ${isDelivery ? 'fa-location-dot' : 'fa-store'}" style="color:var(--primary);width:18px"></i> ${isDelivery ? 'Endereço:' : 'Retirada:'}</span>
        <strong style="text-align:right">${isDelivery ? (order.delivery_address || 'Endereço cadastrado') : 'Retirar no balcão da loja'}</strong>
      </div>
      <div class="tracker-detail-row">
        <span><i class="fa fa-credit-card" style="color:var(--gold);width:18px"></i> Pagamento:</span>
        <strong>${payLabel} (${isPaid ? '<span style="color:#22c55e">Pago</span>' : '<span style="color:#eab308">Pendente</span>'})</strong>
      </div>
      ${order.notes ? `<div class="tracker-detail-row"><span><i class="fa fa-comment" style="color:var(--muted);width:18px"></i> Obs:</span><span>${order.notes}</span></div>` : ''}
    </div>

    <!-- Itens do pedido -->
    <div style="background:var(--bg3);border-radius:12px;padding:12px 14px;margin-bottom:14px">
      <div style="font-size:.82rem;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Itens do Pedido</div>
      ${itemsList}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
        <span style="font-weight:600">Total</span>
        <span style="font-size:1.2rem;font-weight:700;color:var(--gold)">${formatPrice(order.total)}</span>
      </div>
    </div>

    <!-- Suporte via WhatsApp -->
    ${waUrl ? `
      <a href="${waUrl}" target="_blank" class="btn-tracker-wa">
        <i class="fab fa-whatsapp"></i> Dúvidas sobre o pedido? Fale conosco
      </a>
    ` : ''}
  `;
}

function subscribeTrackerRealtime(orderId) {
  const client = getSupabaseClient();
  if (!client) return;

  if (_trackerRealtimeChannel) {
    client.removeChannel(_trackerRealtimeChannel);
    _trackerRealtimeChannel = null;
  }

  try {
    _trackerRealtimeChannel = client.channel(`tracker-${orderId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` }, payload => {
        if (payload.new && _activeTrackerOrderId === String(orderId)) {
          renderTrackerData(payload.new);
          checkActiveOrderPulse();
          showToast(`🔔 Pedido #${orderId}: status atualizado para ${payload.new.status}!`, 'success');
        }
      })
      .subscribe();
  } catch(e) {
    console.warn('Realtime tracker error:', e);
  }

  // Polling de segurança a cada 6 segundos
  clearInterval(_trackerPollingTimer);
  _trackerPollingTimer = setInterval(async () => {
    if (_activeTrackerOrderId === String(orderId)) {
      const updated = await fetchSupabaseOrderById(orderId);
      if (updated) {
        renderTrackerData(updated);
        checkActiveOrderPulse();
      }
    }
  }, 6000);
}
