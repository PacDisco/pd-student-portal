import { createToken } from "./_shared/auth.js";

export async function handler(event) {
  try {
    const { token, email, password } = JSON.parse(event.body);

    if (!token || !email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing fields" })
      };
    }

    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
      "Content-Type": "application/json"
    };

    // Find contact
    const contactRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: "email",
              operator: "EQ",
              value: email
            }]
          }],
          properties: ["email", "portal_token", "portal_token_expiry", "admin_role", "firstname", "portal_token_version"]
        })
      }
    );

    const contactData = await contactRes.json();
    const contact = contactData.results?.[0];

    if (!contact) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Contact not found" })
      };
    }

    const storedToken = contact.properties?.portal_token;
    const expiry = parseInt(contact.properties?.portal_token_expiry || "0");

    if (storedToken !== token || Date.now() > expiry) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, error: "Invalid or expired link" })
      };
    }

    // Save password and clear token
    await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          properties: {
            portal_password: password,
            portal_token: "",
            portal_token_expiry: ""
          }
        })
      }
    );

    // Mint a session token so the user lands logged in (no second login step).
    const cleanEmail = String(email).toLowerCase().trim();
    const adminRole = contact.properties?.admin_role || null;
    const ver = parseInt(contact.properties?.portal_token_version || "0", 10) || 0;
    const sessionToken = createToken({ email: cleanEmail, role: adminRole || "", ver });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        token: sessionToken,
        email: cleanEmail,
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
