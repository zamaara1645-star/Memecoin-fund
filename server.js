import express from "express";
import cron from "node-cron";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

// Load .env manually
if (existsSync("./.env")) {
  const env = readFileSync("./.env", "utf-8");
  env.split("\n").forEach((line) => {
    const [key, ...val] = line.split("=");
    if (key && val.length) process.env[key.trim()] = val.join("=").trim();
  });
}

const app = express();
const PORT = process.env.PORT || 3000;
const WALLET = process.env.WALLET_ADDRESS;
const CACHE_FILE = "./cache.json";

// Free public Solana RPC
const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

// ---------- Cache ----------
let cache = {
  totalUSD: 0, totalSOL: 0, solPrice: 0,
  contributors: 0, lastUpdated: null, txs: [],
};

if (existsSync(CACHE_FILE)) {
  try { cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8")); } catch {}
}

function saveCache() {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ---------- Fetch SOL price (free API, no key) ----------
async function fetchSolPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    if (!res.ok) throw new Error("CoinGecko failed");
    const json = await res.json();
    return json?.solana?.usd || 0;
  } catch (e) {
    console.error("SOL price fetch failed:", e.message);
    return 0;
  }
}

// ---------- Fetch incoming transfers ----------
async function fetchTransfers() {
  const pubKey = new PublicKey(WALLET);
  const signatures = await connection.getSignaturesForAddress(pubKey, { limit: 100 });
  const transfers = [];

  for (const sig of signatures) {
    try {
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) continue;

      // Find the wallet's index in account keys
      const accountKeys = tx.transaction.message.getAccountKeys
        ? tx.transaction.message.getAccountKeys().staticAccountKeys
        : tx.transaction.message.accountKeys;

      const walletIndex = accountKeys.findIndex(
        (k) => k.toString() === WALLET
      );
      if (walletIndex === -1) continue;

      const preBalance = tx.meta.preBalances[walletIndex];
      const postBalance = tx.meta.postBalances[walletIndex];
      const diff = postBalance - preBalance;

      // Only count positive incoming SOL
      if (diff > 0) {
        const senderIndex = accountKeys.findIndex(
          (k) => k.toString() !== WALLET
        );
        transfers.push({
          signature: sig.signature,
          amount: diff, // lamports
          from: senderIndex >= 0 ? accountKeys[senderIndex].toString() : "unknown",
          blockTime: sig.blockTime,
        });
      }
    } catch (e) {
      // Skip failed individual transactions
    }
  }

  return transfers;
}

// ---------- Update progress ----------
async function updateProgress() {
  try {
    const [transfers, solPrice] = await Promise.all([
      fetchTransfers(),
      fetchSolPrice(),
    ]);

    if (solPrice === 0) {
      console.warn("SOL price unavailable; skipping update");
      return;
    }

    let totalLamports = 0;
    const uniqueSenders = new Set();

    for (const tx of transfers) {
      totalLamports += tx.amount;
      if (tx.from && tx.from !== "unknown") uniqueSenders.add(tx.from);
    }

    const totalSOL = totalLamports / LAMPORTS_PER_SOL;
    const totalUSD = totalSOL * solPrice;

    cache = {
      totalSOL: parseFloat(totalSOL.toFixed(6)),
      totalUSD: parseFloat(totalUSD.toFixed(2)),
      solPrice: parseFloat(solPrice.toFixed(2)),
      contributors: uniqueSenders.size,
      lastUpdated: new Date().toISOString(),
      txs: transfers.slice(0, 20).map((t) => ({
        signature: t.signature,
        from: t.from,
        amountSOL: (t.amount / LAMPORTS_PER_SOL).toFixed(4),
        time: t.blockTime,
      })),
    };

    saveCache();
    console.log(`Updated: $${cache.totalUSD} from ${cache.contributors} contributor(s)`);
  } catch (err) {
    console.error("Update failed:", err.message);
  }
}

// ---------- Routes ----------
app.get("/api/campaign/progress", (req, res) => {
  res.json({
    totalUSD: cache.totalUSD || 0,
    totalSOL: cache.totalSOL || 0,
    solPrice: cache.solPrice || 0,
    contributors: cache.contributors || 0,
    goal: 50,
    lastUpdated: cache.lastUpdated,
  });
});

app.get("/api/campaign/transactions", (req, res) => {
  res.json(cache.txs || []);
});

app.get("/", (req, res) => {
  res.sendFile(new URL("./public/fund.html", import.meta.url).pathname);
});

app.use(express.static("public"));

// ---------- Cron: every 5 minutes ----------
cron.schedule("*/5 * * * *", updateProgress);

// Initial run
updateProgress();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
