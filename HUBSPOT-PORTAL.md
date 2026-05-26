# Gating the family gallery behind your HubSpot Customer Portal

The gallery URLs the dashboard generates (e.g. `https://media.pacificdiscovery.org/gallery.html?t=v1.12.1812345.AbC...`) work for anyone with the link. To enforce "must be logged into HubSpot portal", you distribute the link **only via a HubSpot CMS page that's gated to your portal members**. HubSpot handles the login wall; we host the gallery.

This setup works on **CMS Hub Starter and above** (the Customer Portal feature requires a paid HubSpot tier).

---

## One-time setup

### 1. Enable the Customer Portal in HubSpot

1. HubSpot → Settings → **Tools → Service → Customer Portal**
2. Turn it on
3. Configure the login page (logo, welcome text) — this is what families will see before they reach your gallery

### 2. Create a custom contact property to hold each family's trip link

1. Settings → **Properties** → Contacts → **Create property**
2. Label: `Gallery URL`
3. Internal name: `gallery_url`
4. Field type: **Single-line text**
5. Save

This is where you'll paste the gallery URL for each contact who has a kid on a trip. (You can later script this via HubSpot workflows or the API.)

### 3. Build a private CMS page

1. HubSpot → Marketing → Website → **Website Pages → Create**
2. Pick any blank template (you'll add one block to it)
3. In **Settings**, find **Audience Access (private content)** — set this to **Private — Registration required** or scope it to a specific list of contacts (e.g. "Families with active trips")
4. Add a **Rich Text** module to the page and paste the snippet below
5. Publish

### 4. Snippet for the rich text module (paste in source view)

```html
{# Pacific Discovery — Family Gallery link #}
{% if contact %}
  <div style="font-family:-apple-system,sans-serif;max-width:560px;margin:32px auto;padding:32px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;">
    <h2 style="font-size:22px;color:#0f172a;margin-top:0;">Hi {{ contact.firstname }}!</h2>

    {% if contact.gallery_url %}
      <p style="font-size:15px;color:#475569;">
        Photos and videos from your student's trip are ready to view.
        Click below to open the gallery — you can save photos and share within your family.
      </p>
      <p style="text-align:center;margin:24px 0 8px;">
        <a href="{{ contact.gallery_url }}"
           style="display:inline-block;background:#0891b2;color:#fff;text-decoration:none;
                  padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;">
          View trip gallery
        </a>
      </p>
      <p style="font-size:12px;color:#64748b;text-align:center;margin:8px 0 0;">
        This link is private to you. Please don't share it outside your immediate family.
      </p>
    {% else %}
      <p style="font-size:15px;color:#475569;">
        Trip photos aren't available for your account yet — they'll appear here as soon
        as the program team approves them. Check back soon.
      </p>
    {% endif %}
  </div>
{% endif %}
```

This uses HubSpot's HubL templating to:
- Show the logged-in contact's first name
- Show their personal `gallery_url` as a button — but only if they have one
- Show a friendly "not yet" message if they don't

### 5. Note the page URL

After publishing, copy the page URL — something like `https://pacificdiscovery.org/family-gallery`. This is the URL you share with families instead of the raw gallery link.

---

## Daily use — how to give a family their gallery

For each family that should see a trip's gallery:

1. In the **Field Media** dashboard, click **🔗 Family link** on the trip section. Copy the URL.
2. In HubSpot, open the parent's contact record.
3. Paste the URL into the **Gallery URL** property → save.
4. Send them the **HubSpot portal page URL** (not the raw gallery URL). Example email:

```
Hi [Parent name],

[Student]'s trip photos are ready to view! Log in here to see them:

https://pacificdiscovery.org/family-gallery

If you haven't set up a portal account yet, follow the prompts on that page to register.
```

The family logs into HubSpot → lands on the gated page → sees a "View trip gallery" button that opens the gallery in a new tab.

---

## Why this is the right amount of security

- **The portal page is gated by HubSpot** — families can't see the gallery URL without logging in.
- **The gallery URL is signed and expires** in 30 days by default. If a family forwards the URL, the recipient can view too — but only until the expiry, or until you click **Revoke + regenerate** in the dashboard (which kills all outstanding links for that trip instantly).
- **Each trip has its own secret** — revoking Bali's link doesn't affect Cambodia.

This delivers the practical outcome ("families log in to HubSpot to access photos") without requiring HubSpot CMS Hub Pro ($800+/mo) for per-view session verification on every gallery load. If you ever want that stricter model, it's a follow-up build using HubSpot membership JWTs.

---

## Optional — automate the property update

Instead of manually pasting the gallery URL into each contact's `gallery_url` property, you can:

- Create a **HubSpot workflow** triggered when a contact's `program_enrolled` (or similar) property changes → call our `gallery-link` endpoint via a webhook → write the URL to `gallery_url`.
- Or: write a small one-off script that loops your active families and updates them all at once via the HubSpot Contacts API.

Worth doing once you have more than a few dozen families to manage.
