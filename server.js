// 1. Safe dotenv initialization
try {
  require('dotenv').config();
} catch (e) {
  // Gracefully ignored when environment variables are injected directly
}

const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const { KnownDevices } = require('puppeteer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const TARGET_URL = process.env.TARGET_URL || 'https://rexify.com.ng?reference=onaolapopraise';

const mobileDevice = KnownDevices['iPhone 13 Pro'];

app.use(express.static('public'));

let sseClients = [];

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function generateRandomEmail() {
  const randStr = Math.random().toString(36).substring(2, 8);
  return `user_${Date.now()}_${randStr}@gmail.com`;
}

function generateRandomPassword() {
  return `Pass!${Math.random().toString(36).slice(-8)}`;
}

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  req.on('close', () => {
    sseClients = sseClients.filter((client) => client.id !== clientId);
  });
});

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

let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  
  sendLog('Establishing Browserless WebSocket connection...', 'info');
  browserInstance = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSERLESS_WS,
  });

  browserInstance.on('disconnected', () => {
    sendLog('Browserless connection dropped. Reconnect queued for next task.', 'error');
    browserInstance = null;
  });

  return browserInstance;
}

app.post('/api/start', upload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No CSV file uploaded' });
  }

  const accountRows = parseCSVBuffer(req.file.buffer);
  if (accountRows.length === 0) {
    return res.status(400).json({ success: false, error: 'CSV file is empty' });
  }

  res.json({ success: true, count: accountRows.length });

  sendLog(`Loaded ${accountRows.length} account row(s) from CSV. Target: ${TARGET_URL}`, 'info');
  
  if (!process.env.BROWSERLESS_WS) {
    sendLog('ERROR: BROWSERLESS_WS environment variable is missing!', 'error', true);
    return;
  }

  for (let i = 0; i < accountRows.length; i++) {
    const row = accountRows[i];
    const randomEmail = generateRandomEmail();
    const randomPassword = generateRandomPassword();
    const bankName = row.bankName || 'OPay';
    const accountNumber = row.accountNumber || row.account || Object.values(row)[0];

    sendLog(`--- Processing ${i + 1}/${accountRows.length} ---`, 'info');
    sendLog(`Generated Identity: ${randomEmail}`);

    let context = null;
    try {
      const browser = await getBrowser();
      context = await browser.createBrowserContext();
      let page = await context.newPage();

      await page.emulate(mobileDevice);

      // STEP 1: Landing Page
      sendLog(`Navigating to target URL in mobile view...`);
      await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      const getStartedBtn = await page.waitForSelector('text/Get started', { timeout: 15000 });
      await Promise.all([
        getStartedBtn.click(),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
      ]);

      const pages = await context.pages();
      if (pages.length > 1) {
        page = pages[pages.length - 1];
        await page.emulate(mobileDevice);
      }

      sendLog(`Clicked 'Get started'. Current URL: ${page.url()}`);
      await delay(2000);

      // STEP 2: Registration
      sendLog(`Filling signup form with generated credentials...`);
      
      const emailSelector = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 15000 });
      await emailSelector.type(randomEmail, { delay: 40 });

      const passSelector = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 10000 });
      await passSelector.type(randomPassword, { delay: 40 });

      const checkbox = await page.$('input[type="checkbox"]');
      if (checkbox) await checkbox.click();

      const continueBtn = await page.waitForSelector('text/Continue', { timeout: 15000 });
      await Promise.all([
        continueBtn.click(),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
      ]);

      sendLog(`Clicked 'Continue'. Pausing 5s...`);
      await delay(5000);

      // STEP 3: Setup Withdrawals
      sendLog(`Applying mapped Bank (${bankName}) & Account Number (${accountNumber})...`);
      
      await page.waitForSelector('input[placeholder*="account number" i], input[name*="account" i]', { timeout: 15000 });

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

      const accountInput = await page.waitForSelector('input[placeholder*="account number" i], input[name*="account" i]', { timeout: 5000 });
      await accountInput.type(accountNumber, { delay: 40 });

      const verifyBtn = await page.waitForSelector('text/Verify account', { timeout: 15000 });
      await verifyBtn.click();
      sendLog(`Clicked 'Verify account'. Pausing 8s for API verification...`);
      await delay(8000);

      const finishBtn = await page.waitForSelector('text/Finish & continue', { timeout: 15000 });
      await finishBtn.click();
      sendLog(`Clicked 'Finish & continue'. Pausing 5s...`);
      await delay(5000);

      sendLog(`Successfully finished account setup for: ${accountNumber}`, 'info');

    } catch (err) {
      sendLog(`Error processing row ${i + 1} (${accountNumber}): ${err.message}`, 'error');
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  sendLog(`All ${accountRows.length} account tasks executed completely!`, 'info', true);

  if (browserInstance) {
    await browserInstance.disconnect().catch(() => {});
    browserInstance = null;
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
