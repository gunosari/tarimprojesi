
import { readFileSync } from "fs";
import initSqlJs from "sql.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: "No question provided" });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: "API key not set" });
  }

  const SQL = await initSqlJs({ locateFile: file => `https://sql.js.org/dist/${file}` });
  const dbFile = readFileSync("tarimdb.sqlite");
  const db = new SQL.Database(new Uint8Array(dbFile));
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table';");

  const prompt = `
Sen bir tarım veri asistanısın. Aşağıdaki tablo şemasına göre kullanıcının sorusuna uygun SQL sorgusu yaz ve sonucu açıkla.
Tablolar: ${JSON.stringify(tables)}
Kullanıcının Sorusu: ${question}
`;

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await openaiRes.json();
  const sql = data.choices?.[0]?.message?.content;
  if (!sql) return res.status(500).json({ error: "GPT SQL oluşturamadı", raw: data });

  try {
    const result = db.exec(sql);
    res.status(200).json({ sql, result });
  } catch (e) {
    res.status(500).json({ error: "SQL çalıştırılamadı", sql, detail: e.message });
  }
}

