// 1. Crash Guards (Prevents background errors from killing Express on Render)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH GUARD] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception thrown:', err);
});

// 2. Safe dotenv initialization
try {
  require('dotenv').config();
} catch (e) {
  // Gracefully ignored when environment variables are injected directly in production
}

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { KnownDevices } = require('puppeteer');
const Steel = require('steel-sdk');

const app = express();

// Set up Multer for Multiple Files
const upload = multer({ storage: multer.memoryStorage() });
const uploadMiddleware = upload.fields([
  { name: 'accountsFile', maxCount: 1 },
  { name: 'urlsFile', maxCount: 1 }
]);

const PORT = process.env.PORT || 3000;
const mobileDevice = KnownDevices['iPhone 13 Pro'];

// Initialize Steel SDK Client
const steel = new Steel({
  apiKey: process.env.STEEL_API_KEY,
});

// 3. Global CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static('public'));

let sseClients = [];

// --- GLOBAL QUEUE STATE ---
let isRunning = false;
let isStopping = false;

function sendLog(message, type = 'normal', done = false) {
  console.log(`[LOG] ${message}`);
  const payload = JSON.stringify({ message, type, done });

  sseClients = sseClients.filter((client) => {
    try {
      client.res.write(`data: ${payload}\n\n`);
      return true;
    } catch (err) {
      return false;
    }
  });
}

// Dynamic delay helpers
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min = 1000, max = 3000) => 
  delay(Math.floor(Math.random() * (max - min + 1)) + min);

function generateRandomEmail() {
  const randStr = Math.random().toString(36).substring(2, 8);
  return `user_${Date.now()}_${randStr}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

// 4. Server-Sent Events (SSE) Endpoint with Heartbeat Ping
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(': keep-alive\n\n');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  req.on('close', () => {
    sseClients = sseClients.filter((client) => client.id !== clientId);
  });
});

setInterval(() => {
  sseClients.forEach((client) => {
    try {
      client.res.write(': keep-alive\n\n');
    } catch (err) {
      // Cleaned up on disconnect
    }
  });
}, 10000);

// Parser for Accounts (with Headers)
function parseCSVBuffer(buffer) {
  const content = buffer.toString('utf-8');
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });
    return row;
  });
}

// Parser for URLs (Headerless, one URL per line)
function parseUrlsBuffer(buffer) {
  const content = buffer.toString('utf-8');
  return content.trim().split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('http')); // Only keep valid URLs
}

// Single Account Creation Handler with Steel Session Integration
// -> Now accepts `targetUrl` dynamically
async function processAccount(row, rowIndex, workerId, targetUrl) {
  const bankName = row.bankName || 'OPay';
  const accountNumber = row.accountNumber || row.account || Object.values(row)[0];

  const randomEmail = generateRandomEmail();
  const randomPassword = generateRandomPassword();
  sendLog(`[Worker ${workerId}] [Row ${rowIndex + 1}] Processing ${accountNumber} (${randomEmail})`, 'info');

  let session = null;
  let browser = null;

  try {
    session = await steel.sessions.create({});
    browser = await puppeteer.connect({
      browserWSEndpoint: `${session.websocketUrl}&apiKey=${process.env.STEEL_API_KEY}`,
    });

    const openPages = await browser.pages();
    let page = openPages.length > 0 ? openPages[0] : await browser.newPage();

    await page.emulate(mobileDevice);
    page.setDefaultTimeout(25000);

    // STEP 1: Landing Page (Uses dynamic targetUrl)
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await randomDelay(1000, 2000);

    const getStartedBtn = await page.waitForSelector('text/Get started', { visible: true, timeout: 15000 });
    await randomDelay(500, 1000);
    await Promise.all([
      getStartedBtn.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    const pages = await browser.pages();
    if (pages.length > 1) {
      page = pages[pages.length - 1];
      await page.emulate(mobileDevice);
      page.setDefaultTimeout(25000);
    }

    await randomDelay(1500, 3000);

    // STEP 2: Registration
    const emailSelector = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { visible: true, timeout: 15000 });
    await emailSelector.type(randomEmail, { delay: 50 });

    const passSelector = await page.waitForSelector('input[type="password"], input[name="password"]', { visible: true, timeout: 10000 });
    await passSelector.type(randomPassword, { delay: 50 });

    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox) {
      await checkbox.click();
    }

    const continueBtn = await page.waitForSelector('text/Continue', { visible: true, timeout: 15000 });
    await randomDelay(600, 1200);
    await Promise.all([
      continueBtn.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    await randomDelay(3000, 5000);

    // STEP 3: Withdrawal Setup & 7x Retry Verification Loop
    let isVerified = false;
    let verifyAttempt = 0;
    const MAX_VERIFY_ATTEMPTS = 7;

    while (!isVerified && verifyAttempt < MAX_VERIFY_ATTEMPTS) {
      // Early exit if user clicked stop
      if (isStopping) throw new Error('Process forcefully stopped by user.');

      verifyAttempt++;
      sendLog(`[Worker ${workerId}] Verification attempt ${verifyAttempt}/${MAX_VERIFY_ATTEMPTS} for ${accountNumber}...`);

      const accountInput = await page.waitForSelector('input[placeholder*="account number" i], input[name*="account" i]', { visible: true, timeout: 15000 });

      await accountInput.click({ clickCount: 3 });
      await accountInput.press('Backspace');
      await randomDelay(300, 600);
      await accountInput.type(accountNumber, { delay: 50 });

      try {
        await page.select('select', bankName);
      } catch (e) {
        await page.evaluate((bName) => {
          const select = document.querySelector('select');
          if (!select) return;
          for (let option of select.options) {
            if (
              option.text.toLowerCase().includes(bName.toLowerCase()) ||
              option.value.toLowerCase().includes(bName.toLowerCase())
            ) {
              select.value = option.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              break;
            }
          }
        }, bankName);
      }

      const verifyBtn = await page.waitForSelector('text/Verify account', { visible: true, timeout: 15000 });
      await randomDelay(500, 1000);
      await verifyBtn.click();

      const startTime = Date.now();
      let status = 'pending';

      while (Date.now() - startTime < 12000) {
        const result = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          if (bodyText.includes('Account name') || bodyText.includes('Verified')) return 'success';
          if (bodyText.includes('Not verified') || bodyText.includes('Could not verify')) return 'failed';
          return 'pending';
        });

        if (result !== 'pending') {
          status = result;
          break;
        }
        await delay(1000);
      }

      if (status === 'success') {
        isVerified = true;
        sendLog(`[Worker ${workerId}] Account verified successfully for ${accountNumber}!`, 'info');
      } else {
        sendLog(`[Worker ${workerId}] Verification returned '${status}' on attempt ${verifyAttempt}. Re-inputting...`, 'warn');
        await randomDelay(1500, 3000);
      }
    }

    if (!isVerified) throw new Error(`Failed account verification after ${MAX_VERIFY_ATTEMPTS} attempts.`);

    const finishBtn = await page.waitForSelector('text/Finish & continue', { visible: true, timeout: 15000 });
    await randomDelay(800, 1500);
    await finishBtn.click();

    sendLog(`[Worker ${workerId}] Clicked 'Finish & continue'. Stabilizing account (15s)...`);
    await delay(15000);

    return true;

  } catch (err) {
    sendLog(`[Worker ${workerId}] Error on account ${accountNumber}: ${err.message}`, 'error');
    return false;
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
    if (session) await steel.sessions.release(session.id).catch(() => {});
  }
}

// --- API: STOP ROUTE ---
app.post('/api/stop', (req, res) => {
  if (!isRunning) {
    return res.json({ success: false, error: 'Automation is not currently running.' });
  }
  isStopping = true; // Signals workers to break out of loops gracefully
  res.json({ success: true });
});

// --- API: START ROUTE & MULTI-URL ENGINE ---
app.post('/api/start', uploadMiddleware, async (req, res) => {
  try {
    if (isRunning) return res.status(400).json({ success: false, error: 'Process is already running!' });

    if (!req.files || !req.files['accountsFile'] || !req.files['urlsFile']) {
      return res.status(400).json({ success: false, error: 'Both accounts CSV and URLs CSV are required' });
    }

    const accountRows = parseCSVBuffer(req.files['accountsFile'][0].buffer);
    const targetUrls = parseUrlsBuffer(req.files['urlsFile'][0].buffer);

    if (accountRows.length === 0) return res.status(400).json({ success: false, error: 'Accounts CSV is empty' });
    if (targetUrls.length === 0) return res.status(400).json({ success: false, error: 'URLs CSV is empty or invalid' });
    if (!process.env.STEEL_API_KEY) return res.status(500).json({ success: false, error: 'STEEL_API_KEY is missing' });

    res.json({ success: true, accounts: accountRows.length, urls: targetUrls.length });

    // Reset States
    isRunning = true;
    isStopping = false;

    // Background execution starts here
    runMultiUrlEngine(accountRows, targetUrls);

  } catch (err) {
    console.error('Fatal API Error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// --- CORE LOGIC: THE MULTI-URL QUEUE ENGINE ---
async function runMultiUrlEngine(accountRows, targetUrls) {
  const CONCURRENCY = 5;
  const TARGET_SUCCESSES_PER_URL = 20;

  // This index stays persistent across the entire session!
  let globalAccountIndex = 0; 

  sendLog(`\n🚀 ENGINE STARTED | Total Accounts: ${accountRows.length} | Total URLs: ${targetUrls.length}`, 'info');

  for (let urlIdx = 0; urlIdx < targetUrls.length; urlIdx++) {
    if (isStopping) break;
    if (globalAccountIndex >= accountRows.length) {
      sendLog('⚠️ All accounts exhausted! Halting operation.', 'warn');
      break;
    }

    const currentTargetUrl = targetUrls[urlIdx];
    let currentUrlSuccesses = 0;

    sendLog(`\n==================================================`);
    sendLog(`🎯 STARTING URL [${urlIdx + 1}/${targetUrls.length}]: ${currentTargetUrl}`);
    sendLog(`==================================================\n`);

    const worker = async (workerId) => {
      while (currentUrlSuccesses < TARGET_SUCCESSES_PER_URL && !isStopping) {

        // Grab the next account safely
        if (globalAccountIndex >= accountRows.length) break; 

        const myIndex = globalAccountIndex;
        globalAccountIndex++; // Instantly increment so next worker gets a fresh account

        const row = accountRows[myIndex];

        const success = await processAccount(row, myIndex, workerId, currentTargetUrl);

        if (success) {
          currentUrlSuccesses++;
          sendLog(`✅ [Worker ${workerId}] SUCCESS (${currentUrlSuccesses}/${TARGET_SUCCESSES_PER_URL}) on URL ${urlIdx + 1}! (Global Account Row ${myIndex + 1})`, 'info');

          if (currentUrlSuccesses >= TARGET_SUCCESSES_PER_URL) {
            sendLog(`🎉 Target of 20 reached for URL ${urlIdx + 1}.`, 'info');
          }
        } else {
          sendLog(`❌ [Worker ${workerId}] Failed row ${myIndex + 1}. Continuing to next account...`, 'warn');
        }

        await randomDelay(1000, 2500);
      }
    };

    // Spin up 5 parallel workers for this URL
    const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1));
    await Promise.all(workers);

    sendLog(`\n🏁 Finished processing URL ${urlIdx + 1}. Total Successes: ${currentUrlSuccesses}\n`);
  }

  if (isStopping) {
    sendLog(`🛑 Process was manually stopped by user.`, 'error', true);
  } else {
    sendLog(`✅ ALL OPERATIONS COMPLETE. Total Accounts Used: ${globalAccountIndex}`, 'info', true);
  }

  // Reset states
  isRunning = false;
  isStopping = false;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
