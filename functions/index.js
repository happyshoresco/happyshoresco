const functions   = require('firebase-functions');
const admin       = require('firebase-admin');
const sgMail      = require('@sendgrid/mail');
const PDFDoc      = require('pdfkit');
const path        = require('path');
const { ImapFlow }      = require('imapflow');
const { simpleParser } = require('mailparser');

admin.initializeApp();
const db = admin.firestore();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL       = 'hello@happyshoresco.com';
const FROM_NAME        = 'Happy Shores Co';
const COMPANY_PHONE    = '(608) 598-7999';
const COMPANY_WEBSITE  = 'happyshoresco.com';

sgMail.setApiKey(SENDGRID_API_KEY);

const LOGO_PATH       = path.join(__dirname, 'logo.png');
const LOGO_EMAIL_URL  = 'https://happyshoresco.com/logo.png';

// ── Generate PDF buffer from invoice data ──────────────────────────────────────
function generateInvoicePDF(inv) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDoc({ margin: 50, size: 'LETTER' });
    const chunks = [];

    doc.on('data',  chunk => chunks.push(chunk));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const teal  = '#0d7370';
    const ink   = '#0c2e2e';
    const muted = '#4a7070';
    const gold  = '#e8a500';

    // ── Header bar ──
    doc.rect(0, 0, 612, 110).fill(teal);

    // Logo — right side of header as a circular badge
    doc.image(LOGO_PATH, 492, 5, { width: 100, height: 100 });

    doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
      .text('Happy Shores Co', 50, 30);

    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
      .text(`${COMPANY_PHONE}  ·  ${COMPANY_WEBSITE}  ·  ${FROM_EMAIL}`, 50, 58);

    doc.fontSize(20).font('Helvetica-Bold').fillColor(gold)
      .text('INVOICE', 0, 78, { align: 'right', width: 480 });

    // ── Invoice meta ──
    doc.fillColor(ink);
    const invNum = String(inv.invoiceNumber || '').padStart(4, '0');
    doc.fontSize(10).font('Helvetica-Bold').text(`Invoice #${invNum}`, 50, 130);
    doc.fontSize(9).font('Helvetica').fillColor(muted)
      .text(`Date: ${fmtDate(inv.date)}`, 50, 146)
      .text(`Due:  ${fmtDate(inv.dueDate)}`, 50, 160);

    // ── Bill To ──
    doc.fillColor(ink).fontSize(9).font('Helvetica-Bold').text('BILL TO', 300, 130);
    doc.fontSize(10).font('Helvetica').fillColor(ink)
      .text(inv.customerName || '', 300, 146);
    if (inv.customerEmail) doc.text(inv.customerEmail, 300, 160);
    if (inv.customerPhone) doc.text(inv.customerPhone, 300, 174);

    // ── Line items table ──
    let y = 215;
    doc.rect(50, y, 512, 22).fill('#eef4f3');
    doc.fontSize(8).font('Helvetica-Bold').fillColor(muted)
      .text('DESCRIPTION', 58, y + 7)
      .text('QTY',   380, y + 7, { width: 50, align: 'right' })
      .text('PRICE', 435, y + 7, { width: 60, align: 'right' })
      .text('TOTAL', 498, y + 7, { width: 60, align: 'right' });

    y += 22;
    let grandTotal = 0;
    const items = inv.items || [];

    items.forEach((item, i) => {
      const lineTotal = (+item.qty || 0) * (+item.price || 0);
      grandTotal += lineTotal;

      if (i % 2 === 1) doc.rect(50, y, 512, 22).fill('#f7fafa');

      doc.fontSize(9).font('Helvetica').fillColor(ink)
        .text(item.desc || '', 58, y + 6, { width: 310 })
        .text(String(item.qty || 1), 380, y + 6, { width: 50, align: 'right' })
        .text(`$${(+item.price || 0).toFixed(2)}`, 435, y + 6, { width: 60, align: 'right' })
        .text(`$${lineTotal.toFixed(2)}`,           498, y + 6, { width: 60, align: 'right' });

      y += 22;
    });

    // ── Total row ──
    y += 8;
    doc.rect(390, y, 172, 28).fill(teal);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff')
      .text('TOTAL', 398, y + 8, { width: 80 })
      .text(`$${grandTotal.toFixed(2)}`, 398, y + 8, { width: 160, align: 'right' });

    // ── Notes ──
    if (inv.notes) {
      y += 50;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(muted).text('NOTE', 50, y);
      doc.fontSize(9).font('Helvetica').fillColor(ink).text(inv.notes, 50, y + 14, { width: 512 });
    }

    // ── Footer ──
    doc.fontSize(8).font('Helvetica').fillColor(muted)
      .text('Thank you for choosing Happy Shores Co — Madison & Dane County Lake Specialists',
            50, 720, { align: 'center', width: 512 });

    // ── PAID stamp at bottom ──
    if (inv.paid) {
      const stampY = 736;
      doc.rect(170, stampY, 272, 36).lineWidth(2.5).stroke('#059669');
      doc.fontSize(20).font('Helvetica-Bold').fillColor('#059669')
        .text('PAID IN FULL', 170, stampY + 9, { width: 272, align: 'center' });
    }

    doc.end();
  });
}

function fmtDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[+m - 1]} ${+d}, ${y}`;
}

// ── Callable function: sendInvoice ─────────────────────────────────────────────
exports.sendInvoice = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');

  const { invoiceId } = data;
  if (!invoiceId) throw new functions.https.HttpsError('invalid-argument', 'invoiceId required.');

  const invSnap = await db.collection('invoices').doc(invoiceId).get();
  if (!invSnap.exists) throw new functions.https.HttpsError('not-found', 'Invoice not found.');
  const inv = { id: invSnap.id, ...invSnap.data() };

  let customerEmail = inv.customerEmail || '';
  let customerPhone = inv.customerPhone || '';
  if (inv.customerId) {
    const custSnap = await db.collection('customers').doc(inv.customerId).get();
    if (custSnap.exists) {
      const cust = custSnap.data();
      customerEmail = customerEmail || cust.email || '';
      customerPhone = customerPhone || cust.phone || '';
    }
  }
  if (!customerEmail) throw new functions.https.HttpsError('failed-precondition', 'Customer has no email address.');

  inv.customerEmail = customerEmail;
  inv.customerPhone = customerPhone;

  const isPaid  = inv.status === 'paid';
  const invNum  = String(inv.invoiceNumber || '').padStart(4, '0');
  const total   = (inv.items || []).reduce((s, it) => s + (+it.qty * +it.price), 0);

  // Pass paid flag so PDF renders the PAID watermark for receipts
  inv.paid = isPaid;
  const pdfBuffer = await generateInvoicePDF(inv);

  const emailHeader = `
    <div style="background:#f5f0e8;padding:20px;text-align:center;">
      <img src="${LOGO_EMAIL_URL}" width="110" alt="Happy Shores Co" style="display:inline-block;" />
    </div>
    <div style="background:#0d7370;padding:20px 32px;">
      <h1 style="color:#fff;margin:0;font-size:20px;">Happy Shores Co</h1>
      <p style="color:rgba(255,255,255,0.85);margin:5px 0 0;font-size:12px;">${COMPANY_PHONE} · <a href="https://${COMPANY_WEBSITE}" style="color:#e8c97c;text-decoration:none;">${COMPANY_WEBSITE}</a></p>
    </div>`;

  const emailFooter = `
    <div style="background:#081e1e;padding:14px 32px;text-align:center;">
      <p style="color:rgba(255,255,255,0.35);font-size:11px;margin:0;">Happy Shores Co · Madison & Dane County · ${COMPANY_PHONE}</p>
    </div>`;

  let htmlBody, subject;

  if (isPaid) {
    // ── Paid receipt email ────────────────────────────────────────────────────
    subject  = `Payment received — Thank you, ${inv.customerName || 'valued customer'}! Receipt #${invNum}`;
    htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0c2e2e;">
      ${emailHeader}
      <div style="padding:32px;background:#fff;line-height:1.7;">
        <p style="margin:0 0 16px;">Hi ${inv.customerName || 'there'},</p>

        <p style="margin:0 0 16px;">We've received your payment of <strong>$${total.toFixed(2)}</strong> for invoice #${invNum} — thank you so much! Your paid receipt is attached for your records.</p>

        <p style="margin:0 0 16px;">It was a genuine pleasure working on your lakefront. Our goal is always to deliver a five-star experience, and your satisfaction is everything to us. If for any reason the work didn't fully meet your expectations, please reach out right away — we will come back out and make it perfect, no questions asked.</p>

        <p style="margin:0 0 16px;">Also, if you'd like to keep your shoreline looking its best all season without the hassle, ask us about our <strong>subscription maintenance plans</strong> — we'll handle everything on a regular schedule so you can spend more time enjoying the water.</p>

        <p style="margin:0 0 8px;">Thanks again for choosing Happy Shores Co — we truly appreciate your business!</p>
        <p style="margin:0;">Warmly,</p>
        <p style="margin:16px 0 0;font-style:italic;color:#4a7070;">— The Happy Shores Co Team</p>
      </div>
      ${emailFooter}
    </div>`;
  } else {
    // ── Unpaid invoice email ──────────────────────────────────────────────────
    subject  = `Invoice #${invNum} from Happy Shores Co — $${total.toFixed(2)}${inv.dueDate ? ` due ${fmtDate(inv.dueDate)}` : ''}`;
    htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0c2e2e;">
      ${emailHeader}
      <div style="padding:32px;background:#fff;line-height:1.7;">
        <p style="margin:0 0 16px;">Hi ${inv.customerName || 'there'},</p>

        <p style="margin:0 0 16px;">Thank you so much for trusting Happy Shores Co with your lakefront — it truly means the world to us. Please find your invoice #${invNum} attached${inv.dueDate ? `, due on <strong>${fmtDate(inv.dueDate)}</strong>` : ''}. The total amount due is <strong>$${total.toFixed(2)}</strong>.</p>

        <p style="margin:0 0 16px;">If you have any questions about this invoice or would like to discuss payment options, please don't hesitate to reach out — we're always happy to help.</p>

        <p style="margin:0 0 16px;">Our goal is always to deliver a five-star experience. If for any reason the work didn't fully meet your expectations, please let us know and we will come back out and make it right — no questions asked.</p>

        <p style="margin:0 0 8px;">Questions? Call us anytime at ${COMPANY_PHONE} or simply reply to this email.</p>
        <p style="margin:0;">Thanks again — we look forward to hearing from you!</p>
        <p style="margin:16px 0 0;font-style:italic;color:#4a7070;">— The Happy Shores Co Team</p>
      </div>
      ${emailFooter}
    </div>`;
  }

  const textBody = isPaid
    ? `Hi ${inv.customerName || 'there'},\n\nWe've received your payment of $${total.toFixed(2)} for invoice #${invNum} — thank you so much! Your paid receipt is attached for your records.\n\nIt was a genuine pleasure working on your lakefront. If for any reason the work didn't fully meet your expectations, please reach out and we will make it right.\n\nIf you'd like to keep your shoreline looking great all season, ask us about our subscription maintenance plans.\n\nThanks again for choosing Happy Shores Co!\n\n— The Happy Shores Co Team\n${COMPANY_PHONE} · ${COMPANY_WEBSITE}`
    : `Hi ${inv.customerName || 'there'},\n\nThank you for trusting Happy Shores Co with your lakefront. Please find your invoice #${invNum} attached${inv.dueDate ? `, due on ${fmtDate(inv.dueDate)}` : ''}. The total amount due is $${total.toFixed(2)}.\n\nIf you have any questions or would like to discuss payment options, please don't hesitate to reach out.\n\nIf for any reason the work didn't fully meet your expectations, let us know and we will come back out and make it right — no questions asked.\n\nQuestions? Call us at ${COMPANY_PHONE} or reply to this email.\n\n— The Happy Shores Co Team\n${COMPANY_PHONE} · ${COMPANY_WEBSITE}`;

  await sgMail.send({
    to:   customerEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    html: htmlBody,
    text: textBody,
    attachments: [{
      content:     pdfBuffer.toString('base64'),
      filename:    `HappyShores_${isPaid ? 'Receipt' : 'Invoice'}_${invNum}.pdf`,
      type:        'application/pdf',
      disposition: 'attachment',
    }],
  });

  // Paid invoices stay paid; unpaid invoices get marked sent
  const update = { sentAt: admin.firestore.FieldValue.serverTimestamp(), sentTo: customerEmail };
  if (!isPaid) update.status = 'sent';
  await db.collection('invoices').doc(invoiceId).update(update);

  return { success: true, sentTo: customerEmail };
});

// ── Shared: generate a branded quote PDF ──────────────────────────────────────
function generateQuotePDF({ customerName, customerEmail, quoteNum, validUntil, rows, total, notes }) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDoc({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const teal  = '#0d7370';
    const ink   = '#0c2e2e';
    const muted = '#4a7070';
    const gold  = '#e8a500';

    // Header bar
    doc.rect(0, 0, 612, 110).fill(teal);
    doc.image(LOGO_PATH, 492, 5, { width: 100, height: 100 });
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff').text('Happy Shores Co', 50, 30);
    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
      .text(`${COMPANY_PHONE}  ·  ${COMPANY_WEBSITE}  ·  ${FROM_EMAIL}`, 50, 58);
    doc.fontSize(20).font('Helvetica-Bold').fillColor(gold).text('QUOTE', 0, 78, { align: 'right', width: 480 });

    // Meta
    doc.fillColor(ink);
    doc.fontSize(10).font('Helvetica-Bold').text(`Quote #${quoteNum}`, 50, 130);
    doc.fontSize(9).font('Helvetica').fillColor(muted)
      .text(`Date: ${fmtDate(new Date().toISOString().slice(0,10))}`, 50, 146);
    if (validUntil) doc.text(`Valid Until: ${fmtDate(validUntil)}`, 50, 160);

    // Bill To
    doc.fillColor(ink).fontSize(9).font('Helvetica-Bold').text('PREPARED FOR', 300, 130);
    doc.fontSize(10).font('Helvetica').fillColor(ink).text(customerName || '', 300, 146);
    if (customerEmail) doc.text(customerEmail, 300, 160);

    // Line items table
    let y = 210;
    doc.rect(50, y, 512, 22).fill('#eef4f3');
    doc.fontSize(8).font('Helvetica-Bold').fillColor(muted)
      .text('DESCRIPTION', 58, y + 7)
      .text('AMOUNT', 498, y + 7, { width: 60, align: 'right' });
    y += 22;

    rows.forEach((row, i) => {
      if (i % 2 === 1) doc.rect(50, y, 512, 22).fill('#f7fafa');
      const isDiscount = row.amount < 0;
      const color = isDiscount ? '#991b1b' : ink;
      const amtStr = isDiscount
        ? `-$${Math.abs(row.amount).toFixed(2)}`
        : `$${row.amount.toFixed(2)}`;
      doc.fontSize(9).font('Helvetica').fillColor(color)
        .text(row.desc || '', 58, y + 6, { width: 420 })
        .text(amtStr, 498, y + 6, { width: 60, align: 'right' });
      y += 22;
    });

    // Total
    y += 8;
    doc.rect(390, y, 172, 28).fill(teal);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#ffffff')
      .text('TOTAL', 398, y + 8, { width: 80 })
      .text(`$${total.toFixed(2)}`, 398, y + 8, { width: 160, align: 'right' });

    // Notes
    if (notes) {
      y += 50;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(muted).text('NOTE', 50, y);
      doc.fontSize(9).font('Helvetica').fillColor(ink).text(notes, 50, y + 14, { width: 512 });
    }

    // Footer
    doc.fontSize(8).font('Helvetica').fillColor(muted)
      .text('To accept this quote, call (608) 598-7999 or reply to this email — we\'ll get you on the schedule!',
            50, 700, { align: 'center', width: 512 })
      .text('Happy Shores Co · Madison & Dane County Lake Specialists',
            50, 714, { align: 'center', width: 512 });

    doc.end();
  });
}

// ── Callable function: sendQuote ───────────────────────────────────────────────
exports.sendQuote = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');

  const { quoteId, quoteType } = data;
  if (!quoteId || !quoteType) throw new functions.https.HttpsError('invalid-argument', 'quoteId and quoteType required.');

  const collection = quoteType === 'customQuote' ? 'customQuotes' : 'quotes';
  const snap = await db.collection(collection).doc(quoteId).get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Quote not found.');
  const qt = { id: snap.id, ...snap.data() };

  // Get customer email
  let customerEmail = '';
  if (qt.customerId) {
    const custSnap = await db.collection('customers').doc(qt.customerId).get();
    if (custSnap.exists) customerEmail = custSnap.data().email || '';
  }
  if (!customerEmail) throw new functions.https.HttpsError('failed-precondition', 'Customer has no email address.');

  // Build rows for PDF
  let rows = [];
  let total = 0;

  if (quoteType === 'customQuote') {
    rows = (qt.items || []).map(it => ({ desc: it.desc, amount: (+it.qty || 1) * (+it.price || 0) }));
    const subtotal = rows.reduce((s, r) => s + r.amount, 0);
    if (qt.discount > 0) {
      const discAmt = subtotal * (qt.discount / 100);
      rows.push({ desc: `Discount (${qt.discount}%)`, amount: -discAmt });
    }
    total = rows.reduce((s, r) => s + r.amount, 0);
  } else {
    const area     = (qt.length || 0) * (qt.width || 0);
    const baseRaw  = area * 0.08;
    const basePrice = qt.overgrown ? baseRaw * 2 : baseRaw;
    rows.push({ desc: `Lake weed clearing — ${area.toLocaleString()} sq ft @ $0.08/sq ft${qt.overgrown ? ' (overgrown ×2)' : ''}`, amount: basePrice });
    if (qt.permitFee)       rows.push({ desc: 'Dane County permitting fee',         amount: 35 });
    if (qt.difficultAccess) rows.push({ desc: 'Difficult access surcharge',          amount: 25 });
    if (qt.disposal)        rows.push({ desc: 'Weed haul & disposal (compost site)', amount: 40 });
    const subtotal = rows.reduce((s, r) => s + r.amount, 0);
    if (qt.discount > 0) {
      const discAmt = subtotal * (qt.discount / 100);
      rows.push({ desc: `Discount (${qt.discount}%)`, amount: -discAmt });
    }
    total = rows.reduce((s, r) => s + r.amount, 0);
  }

  const quoteNum = String(quoteId).slice(-4).toUpperCase();

  const pdfBuffer = await generateQuotePDF({
    customerName:  qt.customerName,
    customerEmail,
    quoteNum,
    validUntil:    qt.expiry || null,
    rows,
    total,
    notes:         qt.notes || '',
  });

  const validLine = qt.expiry ? `, valid through ${fmtDate(qt.expiry)}` : '';

  // Plain personal-style email — no template, no images, no colored blocks.
  // Styled marketing templates are the primary cause of Promotions tab classification.
  const emailBody =
`Hi ${qt.customerName || 'there'},

Thank you for your interest in Happy Shores Co! Please find your quote attached${validLine ? ` (${validLine.trim()})` : ''}.

If the quote looks good, feel free to call, text, or reply to this email and we'll get you on the schedule right away — ${COMPANY_PHONE}.

If the price isn't quite where you'd like it to be, don't hesitate to reach out. We're always happy to talk through the numbers and find something that works for you. Every lake is a little different and we're flexible on scope.

Looking forward to working with you!

Best,
The Happy Shores Co Team
${COMPANY_PHONE} | ${COMPANY_WEBSITE} | ${FROM_EMAIL}

To make sure our emails reach your inbox, add ${FROM_EMAIL} to your contacts.`;

  const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#222;max-width:560px;">
<p>Hi ${qt.customerName || 'there'},</p>
<p>Thank you for your interest in Happy Shores Co! Please find your quote attached${validLine ? ` (${validLine.trim()})` : ''}.</p>
<p>If the quote looks good, feel free to call, text, or reply to this email and we'll get you on the schedule right away — <a href="tel:+16085987999" style="color:#0d7370;">${COMPANY_PHONE}</a>.</p>
<p>If the price isn't quite where you'd like it to be, don't hesitate to reach out. We're always happy to talk through the numbers and find something that works for you. Every lake is a little different and we're flexible on scope.</p>
<p>Looking forward to working with you!</p>
<p>Best,<br><strong>The Happy Shores Co Team</strong><br>${COMPANY_PHONE} | <a href="https://${COMPANY_WEBSITE}" style="color:#0d7370;">${COMPANY_WEBSITE}</a></p>
<p style="font-size:12px;color:#888;margin-top:24px;">To make sure our emails reach your inbox, add <strong>${FROM_EMAIL}</strong> to your contacts.</p>
</div>`;

  await sgMail.send({
    to:      customerEmail,
    from:    { email: FROM_EMAIL, name: FROM_NAME },
    subject: `Quote from Happy Shores Co`,
    html:    htmlBody,
    text:    emailBody,
    attachments: [{
      content:     pdfBuffer.toString('base64'),
      filename:    `HappyShores_Quote_${quoteNum}.pdf`,
      type:        'application/pdf',
      disposition: 'attachment',
    }],
  });

  await db.collection(collection).doc(quoteId).update({
    status:    'sent',
    sentAt:    admin.firestore.FieldValue.serverTimestamp(),
    sentTo:    customerEmail,
  });

  return { success: true, sentTo: customerEmail };
});

// ── Callable function: sendNewsletter ─────────────────────────────────────────
exports.sendNewsletter = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');

  const { subject, message, listTypes } = data;
  if (!subject || !message || !listTypes?.length)
    throw new functions.https.HttpsError('invalid-argument', 'subject, message, and listTypes are required.');

  const snap = await db.collection('subscribers').get();
  const subscribers = snap.docs
    .map(d => d.data())
    .filter(s => s.email && listTypes.includes(s.listType));

  if (!subscribers.length) return { success: true, sent: 0 };

  const safeMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n').join('<br>');

  let sent = 0;
  for (const sub of subscribers) {
    const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0c2e2e;">
      <div style="background:#f5f0e8;padding:20px;text-align:center;">
        <img src="${LOGO_EMAIL_URL}" width="110" alt="Happy Shores Co" style="display:inline-block;" />
      </div>
      <div style="background:#0d7370;padding:20px 32px;">
        <h1 style="color:#fff;margin:0;font-size:20px;">Happy Shores Co</h1>
        <p style="color:rgba(255,255,255,0.85);margin:5px 0 0;font-size:12px;">${COMPANY_PHONE} · <a href="https://${COMPANY_WEBSITE}" style="color:#e8c97c;text-decoration:none;">${COMPANY_WEBSITE}</a></p>
      </div>
      <div style="padding:32px;background:#fff;line-height:1.8;font-size:15px;">
        <p style="margin:0 0 16px;">Hi ${sub.name || 'there'},</p>
        <div style="margin:0 0 24px;">${safeMessage}</div>
        <p style="margin:0;color:#4a7070;font-size:13px;">Questions? Call ${COMPANY_PHONE} or reply to this email.</p>
        <p style="margin:16px 0 0;font-style:italic;color:#4a7070;">— The Happy Shores Co Team</p>
      </div>
      <div style="background:#081e1e;padding:14px 32px;text-align:center;">
        <p style="color:rgba(255,255,255,0.35);font-size:11px;margin:0;">Happy Shores Co · Madison & Dane County · ${COMPANY_PHONE}</p>
        <p style="color:rgba(255,255,255,0.2);font-size:10px;margin:4px 0 0;">You're receiving this because you're on our mailing list.</p>
      </div>
    </div>`;

    await sgMail.send({
      to:      sub.email,
      from:    { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      html:    htmlBody,
    });
    sent++;
  }

  return { success: true, sent };
});

// ── Callable function: sendAssignmentEmail ────────────────────────────────────
exports.sendAssignmentEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');

  const { jobId, employeeIds } = data;
  if (!jobId || !employeeIds?.length) throw new functions.https.HttpsError('invalid-argument', 'jobId and employeeIds required.');

  const jobSnap = await db.collection('jobs').doc(jobId).get();
  if (!jobSnap.exists) throw new functions.https.HttpsError('not-found', 'Job not found.');
  const job = jobSnap.data();

  const d = job.scheduledDate ? new Date(job.scheduledDate + 'T12:00:00') : null;
  const dateStr = d ? d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' }) : '—';
  const timeStr = job.scheduledTime || '';

  const results = [];
  for (const empId of employeeIds) {
    const empSnap = await db.collection('employees').doc(empId).get();
    if (!empSnap.exists) continue;
    const emp = empSnap.data();
    if (!emp.email) continue;

    const allAssigned = (job.assignedEmployees || []).map(e => e.name).join(', ') || emp.name;

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f7fafa;padding:0;">
      <div style="background:#0d7370;padding:28px 32px;">
        <h1 style="color:#fff;margin:0;font-size:22px;">Happy Shores Co</h1>
        <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:13px;">${COMPANY_PHONE} · ${COMPANY_WEBSITE}</p>
      </div>
      <div style="background:#fff;padding:32px;">
        <p style="color:#4a7070;font-size:13px;margin:0 0 8px;">Hi ${emp.name},</p>
        <p style="color:#0c2e2e;font-size:15px;font-weight:600;margin:0 0 24px;">You've been assigned to a job!</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;border-radius:8px;overflow:hidden;">
          <tr style="background:#eef4f3;">
            <td style="padding:10px 14px;font-weight:600;color:#4a7070;width:40%;">Service</td>
            <td style="padding:10px 14px;color:#0c2e2e;">${job.serviceType || '—'}</td>
          </tr>
          <tr>
            <td style="padding:10px 14px;font-weight:600;color:#4a7070;">Customer</td>
            <td style="padding:10px 14px;color:#0c2e2e;">${job.customerName || '—'}</td>
          </tr>
          <tr style="background:#eef4f3;">
            <td style="padding:10px 14px;font-weight:600;color:#4a7070;">Date</td>
            <td style="padding:10px 14px;color:#0c2e2e;">${dateStr}${timeStr ? ' @ ' + timeStr : ''}</td>
          </tr>
          <tr>
            <td style="padding:10px 14px;font-weight:600;color:#4a7070;">Crew</td>
            <td style="padding:10px 14px;color:#0c2e2e;">${allAssigned}</td>
          </tr>
          ${job.notes ? `<tr style="background:#eef4f3;"><td style="padding:10px 14px;font-weight:600;color:#4a7070;">Notes</td><td style="padding:10px 14px;color:#0c2e2e;">${job.notes}</td></tr>` : ''}
        </table>
        <p style="color:#4a7070;font-size:13px;">Questions? Call <strong>${COMPANY_PHONE}</strong> or reply to this email.</p>
      </div>
      <div style="background:#081e1e;padding:16px 32px;text-align:center;">
        <p style="color:rgba(255,255,255,0.35);font-size:11px;margin:0;">Happy Shores Co · Madison & Dane County · ${COMPANY_PHONE}</p>
      </div>
    </div>`;

    await sgMail.send({
      to:      emp.email,
      from:    { email: FROM_EMAIL, name: FROM_NAME },
      subject: `Job Assignment: ${job.serviceType || 'Service'} on ${dateStr}`,
      html,
    });

    results.push(emp.email);
  }

  return { success: true, notified: results };
});

// ── Scheduled function: checkPermitEmails ─────────────────────────────────────
// Runs every 2 hours. Connects to IMAP inbox, scans for Dane County replies,
// auto-updates permit status in Firestore.
// Requires env vars: IMAP_HOST, IMAP_USER, IMAP_PASS
exports.checkPermitEmails = functions.pubsub
  .schedule('every 2 hours')
  .onRun(async () => {
    const IMAP_HOST = process.env.IMAP_HOST;
    const IMAP_USER = process.env.IMAP_USER;
    const IMAP_PASS = process.env.IMAP_PASS;

    if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
      console.log('IMAP credentials not configured — skipping permit email check.');
      return null;
    }

    const client = new ImapFlow({
      host: IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: IMAP_USER, pass: IMAP_PASS },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    let emailsProcessed = 0;

    try {
      // Search for unread mail from Dane County
      const uids = await client.search({ unseen: true, from: 'countyofdane.com' });

      for await (const msg of client.fetch(uids, { source: true, uid: true })) {
        const parsed  = await simpleParser(msg.source);
        const subject = (parsed.subject || '').toLowerCase();
        const body    = (parsed.text    || '').toLowerCase();
        const full    = `${subject} ${body}`;

        // Detect status
        let newStatus = null;
        if (/\b(approved|issued|granted|permit.*issued)\b/.test(full)) newStatus = 'approved';
        else if (/\b(denied|rejected|not approved|cannot be approved|disapproved)\b/.test(full)) newStatus = 'denied';

        if (!newStatus) {
          // Mark read so we don't reprocess, but don't update status
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
          emailsProcessed++;
          continue;
        }

        // Try to extract a permit number (e.g. DC-2025-001, DCLWR-2025-123, etc.)
        const numMatch = full.match(/\b([a-z]{2,6}[-\s]?\d{4}[-\s]?\d{2,6})\b/i);
        const extractedNum = numMatch ? numMatch[1].toUpperCase().replace(/\s/g, '-') : null;

        // Pull all permits from Firestore and find the best match
        const permSnap = await db.collection('permits').get();
        const permits  = permSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        let match = null;

        // 1. Match by permit number if we extracted one
        if (extractedNum) {
          match = permits.find(p =>
            p.permitNumber && p.permitNumber.toUpperCase().replace(/\s/g, '-') === extractedNum
          );
        }

        // 2. Fallback: match by customer name appearing in the email body
        if (!match) {
          match = permits.find(p =>
            p.customerName && full.includes(p.customerName.toLowerCase())
          );
        }

        // 3. Fallback: match by lake name
        if (!match) {
          match = permits.find(p =>
            p.lake && full.includes(p.lake.toLowerCase())
          );
        }

        if (match && match.status !== newStatus) {
          const update = { status: newStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
          if (extractedNum && !match.permitNumber) update.permitNumber = extractedNum;
          if (newStatus === 'approved') update.autoApprovedAt = admin.firestore.FieldValue.serverTimestamp();
          await db.collection('permits').doc(match.id).update(update);
          console.log(`Permit ${match.id} (${match.customerName}) auto-updated to ${newStatus}`);
        }

        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        emailsProcessed++;
      }
    } finally {
      lock.release();
      await client.logout();
    }

    // Record check timestamp in Firestore for the portal indicator
    await db.collection('meta').doc('permitEmailCheck').set({
      lastChecked:     admin.firestore.FieldValue.serverTimestamp(),
      emailsProcessed: admin.firestore.FieldValue.increment(emailsProcessed),
    }, { merge: true });

    console.log(`Permit email check complete. Processed: ${emailsProcessed}`);
    return null;
  });
