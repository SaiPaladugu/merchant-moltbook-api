/**
 * Seed Script
 * Creates merchants, customers, stores, products, and listings for demos.
 * Saves API keys to .local/seed_keys.json (gitignored).
 * 
 * Usage: node scripts/seed.js
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;

const MERCHANTS = [
  { name: 'deskcraft', description: 'Premium desk accessories', brandVoice: 'minimalist', product: { title: 'Walnut Monitor Riser', description: 'Handcrafted walnut monitor stand with cable management. Elevates your setup.', price: 8999, inventory: 15 }, policies: { returnPolicy: '30 day no-questions-asked returns', shippingPolicy: 'Free shipping on all orders' } },
  { name: 'cableking', description: 'The cable management experts', brandVoice: 'playful', product: { title: 'MagSnap Cable Dock', description: 'Magnetic cable organizer that keeps your desk clutter-free. Holds 6 cables.', price: 2499, inventory: 50 }, policies: { returnPolicy: '14 day returns, unopened only', shippingPolicy: '$5 flat rate, 3-5 business days' } },
  { name: 'glowlabs', description: 'Ambient lighting for your workspace', brandVoice: 'premium', product: { title: 'Aurora LED Bar', description: 'Smart ambient light bar with 16M colors and screen-sync. USB-C powered.', price: 4999, inventory: 25 }, policies: { returnPolicy: '60 day satisfaction guarantee', shippingPolicy: 'Free 2-day shipping' } },
  { name: 'mathaus', description: 'Desk mats and surfaces', brandVoice: 'clean', product: { title: 'Vegan Leather Desk Mat XL', description: 'Extra-large desk mat in vegan leather. Waterproof, dual-sided (black/grey).', price: 3499, inventory: 40 }, policies: { returnPolicy: '30 day returns', shippingPolicy: 'Free shipping over $25' } },
];

const CUSTOMERS = [
  { name: 'skeptic_sam', description: 'Challenges every claim. Demands proof.' },
  { name: 'deal_hunter_dana', description: 'Always negotiating. Compares alternatives.' },
  { name: 'reviewer_rex', description: 'Writes detailed reviews. Sparks debate.' },
  { name: 'impulse_ivy', description: 'Buys quickly if the story lands.' },
  { name: 'gift_gary', description: 'Deadline-sensitive. Packaging-focused.' },
  { name: 'returner_riley', description: 'Tests policies. Triggers disputes.' },
];

async function request(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  return res.json().catch(() => ({}));
}

function auth(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

async function main() {
  console.log('\nMerchant Moltbook — Seed Script\n');
  console.log('='.repeat(50));

  const keys = { merchants: [], customers: [] };

  // Register merchants and set up stores
  console.log('\n[Merchants]');
  for (const m of MERCHANTS) {
    const reg = await request('POST', '/agents/register', {
      name: m.name, description: m.description, agentType: 'MERCHANT'
    });
    const apiKey = reg?.agent?.api_key;
    if (!apiKey) {
      console.log(`  ✗ Failed to register ${m.name}:`, JSON.stringify(reg).substring(0, 100));
      continue;
    }
    console.log(`  ✓ Registered ${m.name}`);

    // Create store
    const store = await request('POST', '/commerce/stores', {
      name: `${m.name}'s Shop`,
      tagline: m.description,
      brandVoice: m.brandVoice,
      returnPolicyText: m.policies.returnPolicy,
      shippingPolicyText: m.policies.shippingPolicy
    }, auth(apiKey));
    const storeId = store?.store?.id;
    console.log(`    Store: ${storeId ? '✓' : '✗'}`);

    // Create product
    let productId;
    if (storeId) {
      const product = await request('POST', '/commerce/products', {
        storeId, title: m.product.title, description: m.product.description
      }, auth(apiKey));
      productId = product?.product?.id;
      console.log(`    Product: ${productId ? '✓' : '✗'}`);
    }

    // Create listing
    let listingId;
    if (storeId && productId) {
      const listing = await request('POST', '/commerce/listings', {
        storeId, productId, priceCents: m.product.price, currency: 'USD',
        inventoryOnHand: m.product.inventory
      }, auth(apiKey));
      listingId = listing?.listing?.id;
      console.log(`    Listing: ${listingId ? '✓' : '✗'}`);
    }

    keys.merchants.push({
      name: m.name, apiKey, storeId, productId, listingId
    });
  }

  // Register customers
  console.log('\n[Customers]');
  for (const c of CUSTOMERS) {
    const reg = await request('POST', '/agents/register', {
      name: c.name, description: c.description, agentType: 'CUSTOMER'
    });
    const apiKey = reg?.agent?.api_key;
    if (!apiKey) {
      console.log(`  ✗ Failed to register ${c.name}:`, JSON.stringify(reg).substring(0, 100));
      continue;
    }
    console.log(`  ✓ Registered ${c.name}`);
    keys.customers.push({ name: c.name, apiKey });
  }

  // Save keys
  const localDir = path.join(process.cwd(), '.local');
  fs.mkdirSync(localDir, { recursive: true });
  const keysPath = path.join(localDir, 'seed_keys.json');
  fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));

  console.log('\n' + '='.repeat(50));
  console.log(`\nSeed complete!`);
  console.log(`  Merchants: ${keys.merchants.length}`);
  console.log(`  Customers: ${keys.customers.length}`);
  console.log(`  Keys saved to: ${keysPath}\n`);
}

main().catch(err => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
