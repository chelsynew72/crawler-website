



interface Env {
  DB: D1Database;
  KV: KVNamespace;
  QUEUE: Queue;
  AI: Ai;
}



function uuid(): string {
  return crypto.randomUUID();
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function notFound(msg = "Not found"): Response {
  return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}



async function callGrok(env: Env, messages: any[]): Promise<string | null> {
  try {
    const systemMsg = messages.find(m => m.role === "system");
    const userMsg = messages.find(m => m.role === "user");

    const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct" as any, {
      messages: [
        { role: "system", content: systemMsg?.content || "" },
        { role: "user",   content: userMsg?.content || "" },
      ],
      max_tokens: 1000,
    }) as any;

    return response?.response || null;
  } catch (error: any) {
    console.error("AI call failed:", error.message);
    return null;
  }
}

async function getCampaigns(env: Env, request: Request): Promise<Response> {
  const userId = getTokenUserId(request);
  if (!userId) return json({ error: "Unauthorized" }, 401);
  const result = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(userId).all();
  return json(result.results);
}

async function createCampaign(env: Env, body: any, request: Request): Promise<Response> {
  const userId = getTokenUserId(request);
  if (!userId) return json({ error: "Unauthorized" }, 401);
  const { name, goal, output_format, schedule_hours } = body;
  if (!name || !goal) return badRequest("name and goal are required");
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO campaigns (id, name, goal, output_format, schedule_hours, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, name, goal, output_format || "report", schedule_hours || 24, userId).run();
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(id).first();
  return json({ message: "Campaign created", campaign }, 201);
}

async function getCampaign(env: Env, id: string, request: Request): Promise<Response> {
  const userId = getTokenUserId(request);
  if (!userId) return json({ error: "Unauthorized" }, 401);
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first();
  if (!campaign) return notFound("Campaign not found");
  const websites = await env.DB.prepare(
    "SELECT * FROM websites WHERE campaign_id = ? ORDER BY created_at DESC"
  ).bind(id).all();
  return json({ ...campaign, websites: websites.results });
}

async function deleteCampaign(env: Env, id: string, request: Request): Promise<Response> {
  const userId = getTokenUserId(request);
  if (!userId) return json({ error: "Unauthorized" }, 401);
  const campaign = await env.DB.prepare(
    "SELECT id FROM campaigns WHERE id = ? AND user_id = ?"
  ).bind(id, userId).first();
  if (!campaign) return notFound("Campaign not found");
  await env.DB.prepare("DELETE FROM insights WHERE campaign_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM crawl_pages WHERE campaign_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM websites WHERE campaign_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
  return json({ message: "Campaign deleted" });
}



async function addWebsite(env: Env, campaignId: string, body: any): Promise<Response> {
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaignId).first();

  if (!campaign) return notFound("Campaign not found");

  const { url } = body;
  if (!url) return badRequest("url is required");

  try { new URL(url); } catch { return badRequest("Invalid URL format"); }

  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO websites (id, campaign_id, url) VALUES (?, ?, ?)`
  ).bind(id, campaignId, url).run();

  const website = await env.DB.prepare(
    "SELECT * FROM websites WHERE id = ?"
  ).bind(id).first();

  return json({ message: "Website added", website }, 201);
}



async function triggerCrawl(env: Env, campaignId: string): Promise<Response> {
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaignId).first() as any;

  if (!campaign) return notFound("Campaign not found");

  const websites = await env.DB.prepare(
    "SELECT * FROM websites WHERE campaign_id = ?"
  ).bind(campaignId).all();

  if (websites.results.length === 0) {
    return badRequest("No websites added to this campaign yet");
  }

  let queued = 0;
  for (const site of websites.results as any[]) {
    await env.DB.prepare(
      "UPDATE websites SET status = 'crawling' WHERE id = ?"
    ).bind(site.id).run();

    await env.QUEUE.send({
      url: site.url,
      campaignId,
      websiteId: site.id,
      baseUrl: site.url,
      depth: 0,
      maxDepth: 4,
      maxPages: 500,
    });
    queued++;
  }

  return json({ message: `Crawl started for ${queued} website(s)`, campaignId });
}

async function getPages(env: Env, campaignId: string): Promise<Response> {
  const pages = await env.DB.prepare(
    `SELECT id, campaign_id, website_id, url, depth, status, word_count, crawled_at
     FROM crawl_pages WHERE campaign_id = ?
     ORDER BY crawled_at DESC LIMIT 200`
  ).bind(campaignId).all();

  return json({ total: pages.results.length, pages: pages.results });
}



async function analyzeCampaign(env: Env, campaignId: string): Promise<Response> {
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaignId).first() as any;

  if (!campaign) return notFound("Campaign not found");

  const pages = await env.DB.prepare(
    `SELECT id, url, content, word_count FROM crawl_pages
     WHERE campaign_id = ? AND status = 'done' AND content IS NOT NULL
     ORDER BY word_count DESC`
  ).bind(campaignId).all();

  if (pages.results.length === 0) {
    return badRequest("No crawled pages found. Run a crawl first.");
  }

  const results = pages.results as any[];
  const pageFindings: any[] = [];

  
  for (const page of results) {
    const content = (page.content || "").substring(0, 3000);
    if (!content || content.length < 50) continue;

    const finding = await callGrok(env, [
      {
        role: "system",
        content: `You are an intelligence analyst. The user has a campaign goal: "${campaign.goal}".
Analyze the webpage content and extract only what is relevant to this goal.
Be concise. If nothing is relevant, say so.
Always respond in this exact JSON format:
{
  "relevant": true or false,
  "findings": ["finding 1", "finding 2"],
  "summary": "one sentence summary"
}`
      },
      {
        role: "user",
        content: `Page URL: ${page.url}\n\nPage content:\n${content}`
      }
    ]);

    if (finding) {
      try {
        const parsed = JSON.parse(finding);
        if (parsed.relevant) {
          await env.DB.prepare(
            `INSERT INTO insights (id, campaign_id, page_id, type, content, source_url)
             VALUES (?, ?, ?, 'page', ?, ?)`
          ).bind(uuid(), campaignId, page.id, JSON.stringify(parsed), page.url).run();

          pageFindings.push({ url: page.url, ...parsed });
        }
      } catch {  }
    }
  }

  
  let summary = null;

  if (pageFindings.length > 0) {
    const findingsText = pageFindings
      .slice(0, 10) // only top 10 findings for summary
      .map((f, i) => `Source ${i + 1}: ${f.url}\nSummary: ${f.summary}`)
      .join("\n\n");

    const summaryResponse = await callGrok(env, [
      {
        role: "system",
        content: `You are an intelligence analyst writing an executive summary.
Campaign goal: "${campaign.goal}"
Write a clear structured summary of the most important insights with sources.
Respond in this exact JSON format:
{
  "headline": "one sentence overall conclusion",
  "key_findings": [
    { "point": "finding", "sources": ["url1", "url2"] }
  ],
  "recommendation": "what the user should do with this information"
}`
      },
      { role: "user", content: findingsText }
    ]);

    if (summaryResponse) {
      try {
        summary = JSON.parse(summaryResponse);
        await env.DB.prepare(
          `INSERT INTO insights (id, campaign_id, type, content)
           VALUES (?, ?, 'summary', ?)`
        ).bind(uuid(), campaignId, JSON.stringify(summary)).run();
      } catch {
        summary = { raw: summaryResponse };
      }
    }
  }

  return json({
    campaign: campaign.name,
    goal: campaign.goal,
    pages_analyzed: results.length,
    relevant_pages: pageFindings.length,
    summary,
    page_findings: pageFindings,
  });
}

async function getInsights(env: Env, campaignId: string): Promise<Response> {
  const insights = await env.DB.prepare(
    "SELECT * FROM insights WHERE campaign_id = ? ORDER BY created_at DESC"
  ).bind(campaignId).all();

  const summary = (insights.results as any[]).find(i => i.type === "summary");
  const pageInsights = (insights.results as any[]).filter(i => i.type === "page");

  return json({
    summary: summary ? JSON.parse(summary.content) : null,
    page_findings: pageInsights.map(i => ({
      source_url: i.source_url,
      ...JSON.parse(i.content),
    })),
  });
}



async function crawlPage(env: Env, job: any): Promise<void> {
  const { url, campaignId, websiteId, baseUrl, depth, maxDepth, maxPages } = job;

  const visitedKey = `visited:${campaignId}:${url}`;
  const visited = await env.KV.get(visitedKey);
  if (visited) return;

  const countResult = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM crawl_pages WHERE campaign_id = ?"
  ).bind(campaignId).first() as any;
  if (countResult.count >= maxPages) return;

  await env.KV.put(visitedKey, "1", { expirationTtl: 60 * 60 * 24 * 7 });

  const pageId = uuid();
  await env.DB.prepare(
    `INSERT INTO crawl_pages (id, campaign_id, website_id, url, depth, status)
     VALUES (?, ?, ?, ?, ?, 'crawling')`
  ).bind(pageId, campaignId, websiteId, url, depth).run();

  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CampaignCrawler/1.0)" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      await env.DB.prepare("UPDATE crawl_pages SET status = 'failed' WHERE id = ?").bind(pageId).run();
      return;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      await env.DB.prepare("UPDATE crawl_pages SET status = 'skipped' WHERE id = ?").bind(pageId).run();
      return;
    }

    const html = await response.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    await env.DB.prepare(
      `UPDATE crawl_pages SET status = 'done', content = ?, word_count = ?,
       crawled_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(text.substring(0, 50000), wordCount, pageId).run();

    await env.DB.prepare(
      "UPDATE websites SET pages_found = pages_found + 1 WHERE id = ?"
    ).bind(websiteId).run();

    if (depth < maxDepth) {
      const baseDomain = new URL(baseUrl).hostname;
      const linkRegex = /href=["']([^"']+)["']/gi;
      const links = new Set<string>();
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        try {
          const href = new URL(match[1], url).href;
          if (new URL(href).hostname === baseDomain && !href.includes("#")) {
            links.add(href);
          }
        } catch { }
      }

      for (const link of links) {
        const alreadyVisited = await env.KV.get(`visited:${campaignId}:${link}`);
        if (!alreadyVisited) {
          await env.QUEUE.send({ url: link, campaignId, websiteId, baseUrl, depth: depth + 1, maxDepth, maxPages });
        }
      }
    }
  } catch {
    await env.DB.prepare("UPDATE crawl_pages SET status = 'failed' WHERE id = ?").bind(pageId).run();
  }
}

async function testGrok(env: Env): Promise<Response> {
  const result = await callGrok(env, [
    { role: "user", content: "Reply with exactly this JSON: {\"status\": \"working\"}" }
  ]);
  return json({ grok_response: result });
}

async function generateSummary(env: Env, campaignId: string): Promise<Response> {
  const campaign = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ?"
  ).bind(campaignId).first() as any;

  if (!campaign) return notFound("Campaign not found");

  // Get existing page insights already saved
  const insights = await env.DB.prepare(
    `SELECT content, source_url FROM insights
     WHERE campaign_id = ? AND type = 'page'
     ORDER BY created_at DESC LIMIT 10`
  ).bind(campaignId).all();

  if (insights.results.length === 0) {
    return badRequest("No page findings yet. Run /analyze first.");
  }

  const findingsText = (insights.results as any[])
    .map((i, idx) => {
      const c = JSON.parse(i.content);
      return `Source ${idx + 1}: ${i.source_url}\nSummary: ${c.summary}`;
    })
    .join("\n\n");

  const summaryResponse = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct" as any,
    {
      messages: [
        {
          role: "system",
          content: `You are an intelligence analyst. Campaign goal: "${campaign.goal}".
Write a short executive summary of findings. Respond in JSON:
{
  "headline": "one sentence conclusion",
  "key_findings": [
    { "point": "finding", "sources": ["url"] }
  ],
  "recommendation": "what to do next"
}`
        },
        { role: "user", content: findingsText }
      ],
      max_tokens: 800,
    }
  ) as any;

  const raw = summaryResponse?.response || null;
  if (!raw) return json({ error: "AI returned nothing" });

  try {
    // Extract JSON from response
   const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0].replace(/\\\\/g, "\\").replace(/\\]/g, "]") : null;
    const parsed = cleaned ? JSON.parse(cleaned) : { raw };

    // Save to DB
    await env.DB.prepare(
      `INSERT INTO insights (id, campaign_id, type, content)
       VALUES (?, ?, 'summary', ?)`
    ).bind(uuid(), campaignId, JSON.stringify(parsed)).run();

    return json({
      campaign: campaign.name,
      goal: campaign.goal,
      summary: parsed,
    });
  } catch {
    return json({ raw });
  }
}

// ── Simple JWT helpers ────────────────────────────────────────────────────────

async function hashPassword(pw: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(pw);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

function makeToken(userId: string): string {
  const payload = btoa(JSON.stringify({ id: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  return `ci.${payload}`;
}

function getTokenUserId(request: Request): string | null {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token.startsWith("ci.")) return null;
  try {
    const payload = JSON.parse(atob(token.replace("ci.", "")));
    if (payload.exp < Date.now()) return null;
    return payload.id;
  } catch { return null; }
}
// ── Auth handlers ─────────────────────────────────────────────────────────────

async function authSignup(env: Env, body: any): Promise<Response> {
  const { first_name, last_name, email, pw } = body;
  if (!first_name || !last_name || !email || !pw) return badRequest("All fields required");
  if (pw.length < 8) return badRequest("Password must be at least 8 characters");

  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "An account with that email already exists" }, 409);

  const id = uuid();
  const hash = await hashPassword(pw);
  await env.DB.prepare(
    "INSERT INTO users (id, first_name, last_name, email, password_hash) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, first_name, last_name, email, hash).run();

  const user = await env.DB.prepare("SELECT id, first_name, last_name, email, plan, created_at FROM users WHERE id = ?").bind(id).first();
  return json({ token: makeToken(id), user }, 201);
}

async function authLogin(env: Env, body: any): Promise<Response> {
  const { email, pw } = body;
  if (!email || !pw) return badRequest("Email and password required");

  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first() as any;
  if (!user) return json({ error: "Invalid email or password" }, 401);

  const hash = await hashPassword(pw);
  if (hash !== user.password_hash) return json({ error: "Invalid email or password" }, 401);

  const { password_hash, ...safeUser } = user;
  return json({ token: makeToken(user.id), user: safeUser });
}

async function authMe(env: Env, request: Request): Promise<Response> {
  const userId = getTokenUserId(request);
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const user = await env.DB.prepare(
    "SELECT id, first_name, last_name, email, plan, created_at FROM users WHERE id = ?"
  ).bind(userId).first();
  if (!user) return json({ error: "User not found" }, 404);
  return json(user);
}

async function authFirebase(env: Env, body: any): Promise<Response> {
  const { firebase_token, first_name, last_name, email, photo_url } = body;
  if (!firebase_token || !email) return badRequest("firebase_token and email required");

  // Check if user exists
  let user = await env.DB.prepare(
    "SELECT id, first_name, last_name, email, plan, created_at FROM users WHERE email = ?"
  ).bind(email).first() as any;

  if (!user) {
    // Create new user from Google data
    const id = uuid();
    const hash = await hashPassword(crypto.randomUUID()); // random password since they use Google
    await env.DB.prepare(
      "INSERT INTO users (id, first_name, last_name, email, password_hash) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, first_name || 'User', last_name || '', email, hash).run();
    user = await env.DB.prepare(
      "SELECT id, first_name, last_name, email, plan, created_at FROM users WHERE id = ?"
    ).bind(id).first();
  }

  return json({ token: makeToken(user.id), user });
}



export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

   if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (method === "GET"  && path === "/campaigns") return getCampaigns(env, request);
    if (method === "POST" && path === "/campaigns") return createCampaign(env, await request.json(), request);

    const campaignMatch  = path.match(/^\/campaigns\/([^/]+)$/);
    const websiteMatch   = path.match(/^\/campaigns\/([^/]+)\/websites$/);
    const crawlMatch     = path.match(/^\/campaigns\/([^/]+)\/crawl$/);
    const pagesMatch     = path.match(/^\/campaigns\/([^/]+)\/pages$/);
    const analyzeMatch   = path.match(/^\/campaigns\/([^/]+)\/analyze$/);
    const insightsMatch  = path.match(/^\/campaigns\/([^/]+)\/insights$/);

    if (method === "GET"  && campaignMatch)  return getCampaign(env, campaignMatch[1], request);
    if (method === "DELETE" && campaignMatch) return deleteCampaign(env, campaignMatch[1], request);
    if (method === "POST" && websiteMatch)   return addWebsite(env, websiteMatch[1], await request.json());
    if (method === "POST" && crawlMatch)     return triggerCrawl(env, crawlMatch[1]);
    if (method === "GET"  && pagesMatch)     return getPages(env, pagesMatch[1]);
    if (method === "POST" && analyzeMatch)   return analyzeCampaign(env, analyzeMatch[1]);
    if (method === "GET"  && insightsMatch)  return getInsights(env, insightsMatch[1]);

    // New auth routes
    if (method === "POST" && path === "/auth/signup")  return authSignup(env, await request.json() as any);
    if (method === "POST" && path === "/auth/login")   return authLogin(env, await request.json() as any);
    if (method === "POST" && path === "/auth/firebase") return authFirebase(env, await request.json());
    if (method === "GET"  && path === "/auth/me")      return authMe(env, request);
    if (method === "POST" && path === "/auth/forgot-password") return json({ message: "If that email exists, a reset link was sent." });

   
    if (method === "GET" && path === "/debug/grok") {
      return testGrok(env);
    }

   
    const summaryMatch = path.match(/^\/campaigns\/([^/]+)\/summary$/);
    if (method === "POST" && summaryMatch) {
      return generateSummary(env, summaryMatch[1]);
    }

    return notFound();
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await crawlPage(env, message.body as any);
      message.ack();
    }
  },
};