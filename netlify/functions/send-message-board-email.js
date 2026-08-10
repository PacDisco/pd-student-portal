// Webhook receiver: HubSpot calls this when a Portal record's
// message_board_posted_at changes. We email the new message-board post
// out to every contact associated with that portal *whose association
// label is Instructor, Parent, or Student* and who has an email address.
//
// This is the email sibling of send-message-board-push.js. Run both from
// the same HubSpot workflow (one "Send a webhook" action each) so people
// get a browser push *and* an email. This function does not touch push
// subscriptions and the push function does not send email — they are
// independent.
//
// Expected POST body (HubSpot workflow webhook). We accept the same
// portal-id shapes the push function does, plus optional message fields:
//   {
//     portalId:    "48837354252",   // required — Portal record id
//                                   //   (or objectId / hs_object_id /
//                                   //    properties.hs_object_id)
//     message:     "...",           // optional — the message-board text.
//                                   //   Also read as body.messageBody /
//                                   //   body.message_board_message.
//     author:      "Jane (Program Leader)", // optional — who posted
//     subject:     "...",           // optional — overrides email subject
//     url:         "https://portal.pacificdiscovery.org/index.html" // optional
//   }
//
// If the message text is NOT in the webhook body, we fall back to reading
// it off the Portal record itself. Set MESSAGE_BOARD_PROPERTY to the
// internal name of the property that holds the latest post; otherwise we
// try a few common names (see MESSAGE_PROP_CANDIDATES below). If we still
// can't find any text, we send a generic "there's a new update, log in to
// read it" email so the notification still goes out.
//
// HubSpot sends a verification GET when you first save the webhook action;
// we 200-OK any GET so that handshake succeeds.
//
// Required env vars:
//   HUBSPOT_API_KEY   — HubSpot private app token, read on contacts +
//                       the Portal custom object + associations.
//   SMTP_USER         — Gmail / Workspace mailbox we send AS
//                       (e.g. info@pacificdiscovery.org).
//   SMTP_PASS         — Google App Password for that mailbox.
//
// Optional env vars:
//   SMTP_FROM_NAME             — sender display name. Default "Pacific Discovery".
//   PORTAL_BASE_URL            — base URL for the "Open the portal" button.
//                                Default https://portal.pacificdiscovery.org
//   WEBHOOK_SHARED_SECRET      — if set, we require a matching
//                                X-Webhook-Secret header (add it in the
//                                HubSpot workflow HTTP-action headers).
//   ALLOWED_ASSOCIATION_LABELS — comma-separated association labels that
//                                should receive the email. Case-insensitive.
//                                Default "instructor,parent,student".
//   MESSAGE_BOARD_PROPERTY     — Portal property holding the latest post
//                                text, if not sent in the webhook body.
//
// Sending limits (same account as send-magic-link): Gmail free ~500/day,
// Workspace ~2000/day. A single trip's parent+student+instructor list is
// well under that. If you ever fan a message out to hundreds of contacts
// at once, move this to a transactional provider (Resend / Postmark /
// SendGrid) and send via their bulk API.

import nodemailer from "nodemailer";

const PORTAL_OBJECT_ID = "2-58411705";

// Portal properties we'll try, in order, when the webhook body doesn't
// carry the message text itself. First non-empty one wins.
const MESSAGE_PROP_CANDIDATES = [
  "message_board_message",
  "message_board_latest",
  "message_board_body",
  "latest_message_board_post",
  "message_board_text",
];

// Reuse the SMTP transport across warm invocations (mirrors send-magic-link).
let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // STARTTLS upgrade — Gmail rejects 465 with these settings
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransporter;
}

export async function handler(event) {
  try {
    // HubSpot verification handshake.
    if (event.httpMethod === "GET") {
      return jsonResponse(200, { ok: true, message: "send-message-board-email listening" });
    }
    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    // Optional shared-secret check.
    if (process.env.WEBHOOK_SHARED_SECRET) {
      const got = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
      if (got !== process.env.WEBHOOK_SHARED_SECRET) {
        console.warn("[send-message-board-email] Refused — bad/no shared secret");
        return jsonResponse(403, { error: "Forbidden" });
      }
    }

    // Env validation up-front.
    const missing = [];
    if (!process.env.HUBSPOT_API_KEY) missing.push("HUBSPOT_API_KEY");
    if (!process.env.SMTP_USER)       missing.push("SMTP_USER");
    if (!process.env.SMTP_PASS)       missing.push("SMTP_PASS");
    if (missing.length) {
      console.error("[send-message-board-email] Missing env:", missing);
      return jsonResponse(500, { error: `Server is not configured (${missing.join(", ")}).` });
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch (_) { return jsonResponse(400, { error: "Invalid JSON body" }); }

    // Accept the same portal-id shapes the push function does.
    const portalId = String(
      body.portalId ||
      body.objectId ||
      body.hs_object_id ||
      body?.properties?.hs_object_id ||
      ""
    ).trim();
    if (!portalId) {
      console.error("[send-message-board-email] no portalId in body:", JSON.stringify(body).slice(0, 400));
      return jsonResponse(400, { error: "Missing portalId / objectId / hs_object_id in webhook body" });
    }

    // Message text (optional) straight from the webhook body.
    let messageText = String(
      body.message ||
      body.messageBody ||
      body.message_board_message ||
      body?.properties?.message_board_message ||
      ""
    ).trim();
    const author = String(body.author || body.posted_by || "").trim();

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json",
    };

    // Which association labels are allowed to receive this email.
    const allowedLabels = new Set(
      (process.env.ALLOWED_ASSOCIATION_LABELS || "instructor,parent,student")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );

    // Look up the trip title (and the message text, if not in the body).
    let tripTitle = "your expedition";
    try {
      const propList = [
        "program_name",
        "portal_title",
        "destination",
        process.env.MESSAGE_BOARD_PROPERTY,
        ...MESSAGE_PROP_CANDIDATES,
      ].filter(Boolean);
      const portalRes = await fetch(
        `https://api.hubapi.com/crm/v3/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}?properties=${encodeURIComponent(propList.join(","))}`,
        { headers }
      );
      if (portalRes.ok) {
        const portal = await portalRes.json();
        const p = portal.properties || {};
        tripTitle = p.program_name || p.portal_title || p.destination || tripTitle;
        if (!messageText) {
          const key = process.env.MESSAGE_BOARD_PROPERTY;
          const candidates = key ? [key, ...MESSAGE_PROP_CANDIDATES] : MESSAGE_PROP_CANDIDATES;
          for (const c of candidates) {
            if (p[c] && String(p[c]).trim()) { messageText = String(p[c]).trim(); break; }
          }
        }
      } else {
        const text = await portalRes.text().catch(() => "");
        console.warn(`[send-message-board-email] portal read ${portalRes.status}: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn("[send-message-board-email] portal read failed (non-fatal):", e?.message || e);
    }

    // 1. List every contact associated to this portal, keeping the
    //    association labels so we can filter by role.
    const assocRes = await fetch(
      `https://api.hubapi.com/crm/v4/objects/${PORTAL_OBJECT_ID}/${encodeURIComponent(portalId)}/associations/contacts?limit=500`,
      { headers }
    );
    if (!assocRes.ok) {
      const text = await assocRes.text().catch(() => "");
      console.error(`[send-message-board-email] association ${assocRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not list associated contacts." });
    }
    const assocData = await assocRes.json();

    // Keep only contacts whose association carries one of the allowed
    // labels (Instructor / Parent / Student). Contacts with no matching
    // label are skipped. Track each kept contact's matched role so we can
    // personalize + report.
    const roleByContactId = new Map();
    for (const r of (assocData.results || [])) {
      const id = r.toObjectId;
      if (!id) continue;
      const labels = (r.associationTypes || [])
        .map(t => (t.label || "").trim())
        .filter(Boolean);
      const matched = labels.find(l => allowedLabels.has(l.toLowerCase()));
      if (matched) roleByContactId.set(String(id), matched);
    }

    const contactIds = [...roleByContactId.keys()];
    const totalAssociated = (assocData.results || []).length;
    if (contactIds.length === 0) {
      console.log(`[send-message-board-email] portal=${portalId}: 0 of ${totalAssociated} associated contacts matched labels [${[...allowedLabels].join(", ")}]`);
      return jsonResponse(200, { sent: 0, attempted: 0, associated: totalAssociated, matched: 0 });
    }

    // 2. Batch-read the matched contacts' email + first name.
    const readRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputs: contactIds.map(id => ({ id: String(id) })),
          properties: ["email", "firstname"],
        }),
      }
    );
    if (!readRes.ok) {
      const text = await readRes.text().catch(() => "");
      console.error(`[send-message-board-email] batch read ${readRes.status}: ${text.slice(0, 200)}`);
      return jsonResponse(502, { error: "Could not read contact details." });
    }
    const readData = await readRes.json();
    const recipients = (readData.results || [])
      .map(c => ({
        id: c.id,
        email: String(c.properties?.email || "").trim(),
        firstName: c.properties?.firstname || "there",
        role: roleByContactId.get(String(c.id)) || "",
      }))
      .filter(c => c.email && /.+@.+\..+/.test(c.email));

    if (recipients.length === 0) {
      console.log(`[send-message-board-email] portal=${portalId}: ${contactIds.length} matched contacts, none with a valid email`);
      return jsonResponse(200, { sent: 0, attempted: 0, associated: totalAssociated, matched: contactIds.length });
    }

    // 3. Build + send one email per recipient.
    const baseUrl  = (process.env.PORTAL_BASE_URL || "https://portal.pacificdiscovery.org").replace(/\/+$/, "");
    const link     = body.url || `${baseUrl}/index.html`;
    const fromName = process.env.SMTP_FROM_NAME || "Pacific Discovery";
    const subject  = body.subject || `${tripTitle} · New message board post`;

    const results = await Promise.allSettled(
      recipients.map(r =>
        getTransporter().sendMail({
          from: `"${fromName}" <${process.env.SMTP_USER}>`,
          to: r.email,
          subject,
          text: buildPlainText({ firstName: r.firstName, tripTitle, messageText, author, link }),
          html: buildHtml({ firstName: r.firstName, tripTitle, messageText, author, link }),
        })
      )
    );

    let sent = 0, failed = 0;
    results.forEach((res, i) => {
      if (res.status === "fulfilled") { sent++; return; }
      failed++;
      const err = res.reason || {};
      console.warn(`[send-message-board-email] send failed for ${recipients[i].email}: ${err?.message || err}`);
    });

    console.log(`[send-message-board-email] portal=${portalId} associated=${totalAssociated} matched=${contactIds.length} sent=${sent} failed=${failed}`);
    return jsonResponse(200, {
      sent,
      failed,
      attempted: recipients.length,
      associated: totalAssociated,
      matched: contactIds.length,
    });

  } catch (err) {
    console.error("[send-message-board-email] Unhandled:", err?.stack || err?.message || err);
    return jsonResponse(500, { error: err?.message || "Server error" });
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// ---------- email body builders ----------

function buildPlainText({ firstName, tripTitle, messageText, author, link }) {
  const lines = [
    `Hi ${firstName},`,
    ``,
    `There's a new post on the ${tripTitle} Message Board.`,
    ``,
  ];
  if (messageText) {
    if (author) lines.push(`${author} wrote:`);
    lines.push(messageText, ``);
  } else {
    lines.push(`Log in to the portal to read it.`, ``);
  }
  lines.push(`Open the portal: ${link}`, ``, `— Pacific Discovery`);
  return lines.join("\n");
}

function buildHtml({ firstName, tripTitle, messageText, author, link }) {
  // Inline styles only — renders consistently across Gmail, Apple Mail,
  // Outlook web, and mobile clients. Mirrors send-magic-link's layout.
  const safeName  = escapeHtml(firstName);
  const safeTrip  = escapeHtml(tripTitle);
  const safeLink  = escapeHtml(link);
  const safeAuthor = author ? escapeHtml(author) : "";
  // Preserve line breaks in the message body; escape everything else.
  const safeMsg = messageText
    ? escapeHtml(messageText).replace(/\r?\n/g, "<br>")
    : "";

  const messageBlock = safeMsg
    ? `
        <tr><td style="padding:8px 32px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8; border:1px solid #e5e7eb; border-radius:6px;">
            <tr><td style="padding:16px 20px; font-size:14px; line-height:1.6; color:#333;">
              ${safeAuthor ? `<div style="font-size:12px; color:#888; margin:0 0 8px;">${safeAuthor} wrote:</div>` : ""}
              ${safeMsg}
            </td></tr>
          </table>
        </td></tr>`
    : `
        <tr><td style="padding:8px 32px 8px; font-size:14px; line-height:1.6; color:#444;">
          <p style="margin:0;">Log in to the portal to read it.</p>
        </td></tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#f8f8f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#212121;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f8f8;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border:1px solid #e5e7eb;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:11px; letter-spacing:1.5px; color:#999; font-weight:600;">PACIFIC DISCOVERY</div>
          <h1 style="margin:12px 0 0; font-size:22px; font-weight:600; color:#212121;">New message board post</h1>
          <p style="margin:6px 0 0; font-size:14px; color:#666;">${safeTrip}</p>
        </td></tr>
        <tr><td style="padding:16px 32px 4px; font-size:14px; line-height:1.6; color:#444;">
          <p style="margin:0;">Hi ${safeName},</p>
        </td></tr>
        ${messageBlock}
        <tr><td align="center" style="padding:16px 32px 24px;">
          <a href="${safeLink}" style="display:inline-block; padding:14px 28px; background:#3B5998; color:#ffffff; text-decoration:none; font-size:13px; font-weight:600; letter-spacing:1.5px; border-radius:4px;">OPEN THE PORTAL</a>
        </td></tr>
        <tr><td style="padding:0 32px 28px; font-size:12px; line-height:1.6; color:#888; border-top:1px solid #e5e7eb; padding-top:16px;">
          <p style="margin:14px 0 0;">You're receiving this because you're linked to this trip in the Pacific Discovery portal.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
