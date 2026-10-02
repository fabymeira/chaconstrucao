import express from "express";
import helmet from "helmet";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "cha-construcao.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  total_qty INTEGER NOT NULL,
  sold_qty INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  mp_order_id TEXT,
  buyer_name TEXT,
  buyer_email TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL,
  item_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`);

const seed = db.prepare("SELECT COUNT(*) AS c FROM items").get().c;
if (!seed) {
  const insert = db.prepare("INSERT INTO items(name,price_cents,total_qty) VALUES(?,?,?)");
  const items = [
    ["Cimento", 3500, 100],
    ["Elétrica", 10000, 25],
    ["Hidráulica", 8500, 30],
    ["Revestimento", 5000, 250],
    ["Laje", 7000, 100],
    ["Ferragem", 4500, 100],
    ["Pintura", 3500, 250]
  ];
  const tx = db.transaction(() => items.forEach(x => insert.run(...x)));
  tx();
}
db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('target_cents','4275900')").run();

const money = cents => (cents / 100).toLocaleString("pt-BR", {style:"currency", currency:"BRL"});
const now = () => new Date().toISOString();

function getRaised() {
  const row = db.prepare("SELECT COALESCE(SUM(total_cents),0) AS total FROM orders WHERE status='approved'").get();
  return row.total;
}
function publicData() {
  const target = Number(db.prepare("SELECT value FROM settings WHERE key='target_cents'").get().value);
  const items = db.prepare(`
    SELECT id,name,price_cents AS priceCents,total_qty AS totalQty,
           MAX(total_qty-sold_qty,0) AS remaining
    FROM items WHERE active=1 ORDER BY id
  `).all();
  const raised = getRaised();
  return {targetCents:target, raisedCents:raised, percent: Math.min(100, raised/target*100), items};
}

app.get("/api/public", (req,res) => res.json(publicData()));

function auth(req,res,next){
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return res.set("WWW-Authenticate",'Basic realm="Painel"').status(401).send("Autenticação necessária");
  const [u,p] = Buffer.from(h.slice(6),"base64").toString().split(":");
  if (u !== (process.env.ADMIN_USER||"admin") || p !== (process.env.ADMIN_PASSWORD||"troque-esta-senha")) return res.status(403).send("Acesso negado");
  next();
}

app.get("/admin", auth, (req,res) => res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/api/admin", auth, (req,res) => {
  const orders = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100").all();
  res.json({...publicData(), orders});
});

app.post("/api/admin/settings", auth, (req,res) => {
  const target = Math.round(Number(req.body.targetCents));
  if (!Number.isInteger(target) || target <= 0) return res.status(400).json({error:"Meta inválida"});
  db.prepare("UPDATE settings SET value=? WHERE key='target_cents'").run(String(target));
  res.json(publicData());
});

app.post("/api/admin/item", auth, (req,res) => {
  const {id,name,priceCents,totalQty,active=true} = req.body;
  if (!name || !Number.isInteger(Number(priceCents)) || !Number.isInteger(Number(totalQty))) return res.status(400).json({error:"Dados inválidos"});
  if (id) db.prepare("UPDATE items SET name=?,price_cents=?,total_qty=?,active=? WHERE id=?")
    .run(name,Number(priceCents),Number(totalQty),active?1:0,Number(id));
  else db.prepare("INSERT INTO items(name,price_cents,total_qty,active) VALUES(?,?,?,?)")
    .run(name,Number(priceCents),Number(totalQty),active?1:0);
  res.json(publicData());
});

function verifyWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return process.env.DEMO_MODE === "true";
  const sig = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"] || "";
  const dataId = String(req.query["data.id"] || req.query.data_id || "").toLowerCase();
  if (!sig || !dataId) return false;
  let ts="", v1="";
  for (const part of String(sig).split(",")) {
    const [k,...rest] = part.split("=");
    const v = rest.join("=").trim();
    if (k.trim()==="ts") ts=v;
    if (k.trim()==="v1") v1=v;
  }
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hash = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  return v1 && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(v1));
}

async function mpCreateOrder(orderId, totalCents, items, buyerEmail) {
  const body = {
    type:"online",
    processing_mode:"manual",
    capture_mode:"automatic_async",
    total_amount:(totalCents/100).toFixed(2),
    external_reference:orderId,
    description:"Contribuição para o Chá de Construção",
    payer: buyerEmail ? {email:buyerEmail} : undefined,
    items: items.map(x=>({
      title:x.name,
      unit_price:(x.priceCents/100).toFixed(2),
      quantity:x.qty,
      total_amount:((x.priceCents*x.qty)/100).toFixed(2),
      unit_measure:"unit"
    })),
    config:{
      payment_method:{
        // Mantém Pix (bank_transfer), crédito e débito.
        // Exclui boleto, saldo/carteira e pré-pago.
        not_allowed_types:["ticket","account_money","digital_currency","prepaid_card"],
        max_installments:12
      },
      online:{
        success_url:`${process.env.SITE_URL}/?payment=success&order=${orderId}`,
        failure_url:`${process.env.SITE_URL}/?payment=failure&order=${orderId}`,
        pending_url:`${process.env.SITE_URL}/?payment=pending&order=${orderId}`,
        auto_return:"all"
      }
    }
  };
  Object.keys(body).forEach(k => body[k]===undefined && delete body[k]);
  const r = await fetch("https://api.mercadopago.com/v1/orders",{
    method:"POST",
    headers:{
      "Authorization":`Bearer ${process.env.MP_ACCESS_TOKEN}`,
      "Content-Type":"application/json",
      "X-Idempotency-Key":crypto.randomUUID()
    },
    body:JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || `Mercado Pago HTTP ${r.status}`);
  return data;
}

app.post("/api/order", async (req,res) => {
  try {
    const selections = Array.isArray(req.body.selections) ? req.body.selections : [];
    const customCents = Math.round(Number(req.body.customCents || 0));
    const buyerName = String(req.body.buyerName || "").slice(0,120);
    const buyerEmail = String(req.body.buyerEmail || "").slice(0,160);
    if (!selections.length && customCents<=0) return res.status(400).json({error:"Escolha uma contribuição."});

    const chosen=[];
    let total=customCents;
    for (const s of selections) {
      const item = db.prepare("SELECT * FROM items WHERE id=? AND active=1").get(Number(s.itemId));
      const qty = Number(s.qty);
      if (!item || !Number.isInteger(qty) || qty<1) return res.status(400).json({error:"Item inválido."});
      const remaining = item.total_qty-item.sold_qty;
      if (qty>remaining) return res.status(409).json({error:`Restam apenas ${remaining} cotas de ${item.name}.`});
      chosen.push({id:item.id,name:item.name,qty,priceCents:item.price_cents});
      total += item.price_cents*qty;
    }
    if (total<=0) return res.status(400).json({error:"Valor inválido."});

    const orderId = "CHA-" + crypto.randomUUID();
    db.prepare("INSERT INTO orders(id,total_cents,status,buyer_name,buyer_email,created_at) VALUES(?,?,?,?,?,?)")
      .run(orderId,total,"pending",buyerName,buyerEmail,now());
    const ins = db.prepare("INSERT INTO order_items(order_id,item_id,name,qty,unit_price_cents) VALUES(?,?,?,?,?)");
    const tx = db.transaction(()=>chosen.forEach(x=>ins.run(orderId,x.id,x.name,x.qty,x.priceCents)));
    tx();

    if (process.env.DEMO_MODE === "true" || !process.env.MP_ACCESS_TOKEN) {
      return res.json({demo:true,orderId,checkoutUrl:null,totalCents:total});
    }
    const mp = await mpCreateOrder(orderId,total,chosen,buyerEmail);
    db.prepare("UPDATE orders SET mp_order_id=? WHERE id=?").run(mp.id,orderId);
    res.json({demo:false,orderId,checkoutUrl:mp.checkout_url,totalCents:total});
  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Não foi possível iniciar o pagamento. Tente novamente."});
  }
});

app.post("/api/webhooks/mercadopago", async (req,res) => {
  if (!verifyWebhook(req)) return res.status(401).send("invalid signature");
  res.sendStatus(200);

  try {
    const eventId = String(req.body?.id || `${req.query["data.id"]||""}-${Date.now()}`);
    const exists = db.prepare("SELECT 1 FROM webhook_events WHERE event_id=?").get(eventId);
    if (exists) return;

    db.prepare("INSERT INTO webhook_events(event_id,created_at) VALUES(?,?)").run(eventId,now());
    const orderId = String(req.body?.data?.id || req.query["data.id"] || "");
    if (!orderId) return;

    if (!process.env.MP_ACCESS_TOKEN) return;
    const r = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(orderId)}`,{
      headers:{Authorization:`Bearer ${process.env.MP_ACCESS_TOKEN}`}
    });
    if (!r.ok) return;
    const mpOrder = await r.json();
    const localId = mpOrder.external_reference;
    if (!localId) return;
    const local = db.prepare("SELECT * FROM orders WHERE id=?").get(localId);
    if (!local || local.status==="approved") return;

    if (mpOrder.status === "processed" || mpOrder.status === "approved") {
      const localItems = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(localId);
      const tx = db.transaction(()=>{
        for (const x of localItems) {
          const item = db.prepare("SELECT * FROM items WHERE id=?").get(x.item_id);
          if (item && item.sold_qty + x.qty <= item.total_qty) {
            db.prepare("UPDATE items SET sold_qty=sold_qty+? WHERE id=?").run(x.qty,item.id);
          }
        }
        db.prepare("UPDATE orders SET status='approved',paid_at=? WHERE id=?").run(now(),localId);
      });
      tx();
    } else if (["cancelled","rejected","expired"].includes(String(mpOrder.status))) {
      db.prepare("UPDATE orders SET status=? WHERE id=?").run(mpOrder.status,localId);
    }
  } catch(e){ console.error("Webhook:",e); }
});

app.get("/api/order-status/:id",(req,res)=>{
  const o=db.prepare("SELECT id,total_cents,status FROM orders WHERE id=?").get(req.params.id);
  if(!o) return res.status(404).json({error:"Pedido não encontrado"});
  res.json(o);
});

const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log(`Chá de Construção em http://localhost:${port}`));
