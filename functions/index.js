const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const sgMail    = require('@sendgrid/mail');
const PDFDoc    = require('pdfkit');

admin.initializeApp();
const db = admin.firestore();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL       = 'thehappyshoresco@gmail.com';
const FROM_NAME        = 'Happy Shores Co';
const COMPANY_PHONE    = '(608) 345-2345';
const COMPANY_WEBSITE  = 'happyshoresco.com';

sgMail.setApiKey(SENDGRID_API_KEY);

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
    doc.rect(0, 0, 612, 90).fill(teal);

    doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
      .text('Happy Shores Co', 50, 28);

    doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.75)')
      .text(`${COMPANY_PHONE}  ·  ${COMPANY_WEBSITE}  ·  ${FROM_EMAIL}`, 50, 56);

    doc.fontSize(20).font('Helvetica-Bold').fillColor(gold)
      .text('INVOICE', 0, 32, { align: 'right', width: 562 });

    // ── Invoice meta ──
    doc.fillColor(ink);
    const invNum = String(inv.invoiceNumber || '').padStart(4, '0');
    doc.fontSize(10).font('Helvetica-Bold').text(`Invoice #${invNum}`, 50, 110);
    doc.fontSize(9).font('Helvetica').fillColor(muted)
      .text(`Date: ${fmtDate(inv.date)}`, 50, 126)
      .text(`Due:  ${fmtDate(inv.dueDate)}`, 50, 140);

    // ── Bill To ──
    doc.fillColor(ink).fontSize(9).font('Helvetica-Bold').text('BILL TO', 300, 110);
    doc.fontSize(10).font('Helvetica').fillColor(ink)
      .text(inv.customerName || '', 300, 126);
    if (inv.customerEmail) doc.text(inv.customerEmail, 300, 140);
    if (inv.customerPhone) doc.text(inv.customerPhone, 300, 154);

    // ── Line items table ──
    let y = 195;
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

  // Fetch invoice
  const invSnap = await db.collection('invoices').doc(invoiceId).get();
  if (!invSnap.exists) throw new functions.https.HttpsError('not-found', 'Invoice not found.');
  const inv = { id: invSnap.id, ...invSnap.data() };

  // Fetch customer for email/phone
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

  // Attach customer info to invoice for PDF
  inv.customerEmail = customerEmail;
  inv.customerPhone = customerPhone;

  // Generate PDF
  const pdfBuffer = await generateInvoicePDF(inv);
  const invNum    = String(inv.invoiceNumber || '').padStart(4, '0');

  // Build totals for email body
  const total = (inv.items || []).reduce((s, it) => s + (+it.qty * +it.price), 0);

  const htmlBody = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f7fafa;padding:0;">
    <div style="background:#0d7370;padding:28px 32px;">
      <h1 style="color:#fff;margin:0;font-size:22px;">Happy Shores Co</h1>
      <p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:13px;">${COMPANY_PHONE} · ${COMPANY_WEBSITE}</p>
    </div>
    <div style="background:#fff;padding:32px;">
      <p style="color:#4a7070;font-size:13px;margin:0 0 24px;">Hi ${inv.customerName || 'there'},</p>
      <p style="color:#0c2e2e;font-size:15px;margin:0 0 24px;">
        Please find your invoice attached as a PDF. Here's a summary:
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
        <tr style="background:#eef4f3;">
          <th style="text-align:left;padding:10px 12px;color:#4a7070;font-size:11px;text-transform:uppercase;">Description</th>
          <th style="text-align:right;padding:10px 12px;color:#4a7070;font-size:11px;text-transform:uppercase;">Qty</th>
          <th style="text-align:right;padding:10px 12px;color:#4a7070;font-size:11px;text-transform:uppercase;">Amount</th>
        </tr>
        ${(inv.items || []).map((it, i) => `
        <tr style="background:${i % 2 === 1 ? '#f7fafa' : '#fff'}">
          <td style="padding:10px 12px;color:#0c2e2e;">${it.desc || ''}</td>
          <td style="padding:10px 12px;text-align:right;color:#0c2e2e;">${it.qty}</td>
          <td style="padding:10px 12px;text-align:right;color:#0c2e2e;">$${(+it.qty * +it.price).toFixed(2)}</td>
        </tr>`).join('')}
        <tr style="background:#0d7370;">
          <td colspan="2" style="padding:12px;color:#fff;font-weight:bold;">Total Due</td>
          <td style="padding:12px;text-align:right;color:#fff;font-weight:bold;font-size:16px;">$${total.toFixed(2)}</td>
        </tr>
      </table>
      ${inv.dueDate ? `<p style="color:#0c2e2e;font-size:13px;"><strong>Due date:</strong> ${fmtDate(inv.dueDate)}</p>` : ''}
      ${inv.notes  ? `<p style="color:#4a7070;font-size:13px;border-left:3px solid #0d7370;padding-left:12px;margin:16px 0;">${inv.notes}</p>` : ''}
      <p style="color:#4a7070;font-size:13px;margin:24px 0 0;">
        Questions? Call us at <strong>${COMPANY_PHONE}</strong> or reply to this email.
      </p>
      <p style="color:#4a7070;font-size:13px;">Thank you for choosing Happy Shores Co!</p>
    </div>
    <div style="background:#081e1e;padding:16px 32px;text-align:center;">
      <p style="color:rgba(255,255,255,0.35);font-size:11px;margin:0;">
        Happy Shores Co · Madison & Dane County · ${COMPANY_PHONE}
      </p>
    </div>
  </div>`;

  const msg = {
    to:   customerEmail,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: `Invoice #${invNum} from Happy Shores Co — $${total.toFixed(2)} due ${fmtDate(inv.dueDate)}`,
    html: htmlBody,
    attachments: [{
      content:     pdfBuffer.toString('base64'),
      filename:    `HappyShores_Invoice_${invNum}.pdf`,
      type:        'application/pdf',
      disposition: 'attachment',
    }],
  };

  await sgMail.send(msg);

  // Mark invoice as sent in Firestore
  await db.collection('invoices').doc(invoiceId).update({
    status:   'sent',
    sentAt:   admin.firestore.FieldValue.serverTimestamp(),
    sentTo:   customerEmail,
  });

  return { success: true, sentTo: customerEmail };
});
