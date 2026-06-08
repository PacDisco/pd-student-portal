import { createToken } from "./_shared/auth.js";

export async function handler(event) {
  try {
    const { email, password } = JSON.parse(event.body);

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing email or password" })
      };
    }

    const cleanEmail = email.toLowerCase().trim();

    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: cleanEmail
            }]
          }],
          // admin_role + firstname are returned to the browser so the
          // login page can route admins straight to /admin.html and
          // greet by name. portal_password is what we authenticate against.
          properties: ["email", "portal_password", "admin_role", "firstname", "portal_token_version"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Email not found" })
      };
    }

    const storedPassword = contact.properties?.portal_password;

    if (!storedPassword) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "no_password" })
      };
    }

    if (storedPassword !== password) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Incorrect password" })
      };
    }

    const adminRole = contact.properties?.admin_role || null;
    const ver = parseInt(contact.properties?.portal_token_version || "0", 10) || 0;
    // Signed session token — the browser stores this and sends it as a Bearer
    // header on every API call. Identity (email/role) is read from the token
    // server-side, so the client can no longer assert who it is.
    const token = createToken({ email: cleanEmail, role: adminRole || "", ver });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        token,
        email: cleanEmail,
        // Optional fields. The login page checks adminRole to decide
        // whether to land the user on /admin.html or the regular portal.
        adminRole,
        firstName: contact.properties?.firstname || null
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
