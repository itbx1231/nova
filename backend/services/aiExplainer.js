const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const REPORTS_DIR = path.join(__dirname, '../reports');

async function generateExplanation() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("No AI API Key found (GEMINI_API_KEY or OPENAI_API_KEY). Skipping AI summary.");
        return;
    }

    // Find the latest JSON report
    let latestReportPath = path.join(REPORTS_DIR, 'latest.json');
    if (!fs.existsSync(latestReportPath)) {
        console.error("latest.json not found in reports directory.");
        return;
    }

    try {
        const reportData = fs.readFileSync(latestReportPath, 'utf8');
        const reportJson = JSON.parse(reportData);

        // Prepare the prompt
        const prompt = `
أنت مهندس خبير في البنية التحتية (DevOps/Platform Engineer).
هذا تقرير الفحص اليومي لسيرفراتنا بصيغة JSON.
قم بتحليل البيانات وكتابة ملخص احترافي وسهل القراءة باللغة العربية يشرح:
1. الحالة العامة للسيرفرات (هل هناك أي خطورة؟)
2. حالة الأقراص (المساحات، الحرارة إذا توفرت)
3. الموارد الأساسية (المعالج، الذاكرة)
4. توصيات إن وجدت.

البيانات:
${JSON.stringify(reportJson, null, 2)}
        `;

        console.log("Requesting AI summary...");

        let aiSummary = "";

        if (process.env.GEMINI_API_KEY) {
            aiSummary = await callGemini(process.env.GEMINI_API_KEY, prompt);
        } else if (process.env.OPENAI_API_KEY) {
            aiSummary = await callOpenAI(process.env.OPENAI_API_KEY, prompt);
        }

        if (aiSummary) {
            const summaryPath = path.join(REPORTS_DIR, 'ai-summary-latest.md');
            fs.writeFileSync(summaryPath, aiSummary, 'utf8');
            console.log(`AI Summary generated and saved to ${summaryPath}`);
        }

    } catch (err) {
        console.error("Error generating AI explanation:", err);
    }
}

// Helper function to call Gemini API natively
function callGemini(apiKey, promptText) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }]
        });

        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.error("Gemini Error:", body);
                    return resolve("خطأ في الاتصال بالذكاء الاصطناعي.");
                }
                try {
                    const json = JSON.parse(body);
                    const text = json.candidates[0].content.parts[0].text;
                    resolve(text);
                } catch (e) {
                    resolve("تعذر تحليل استجابة الذكاء الاصطناعي.");
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

// Helper function to call OpenAI API natively
function callOpenAI(apiKey, promptText) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: promptText }]
        });

        const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': data.length
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.error("OpenAI Error:", body);
                    return resolve("خطأ في الاتصال بالذكاء الاصطناعي.");
                }
                try {
                    const json = JSON.parse(body);
                    const text = json.choices[0].message.content;
                    resolve(text);
                } catch (e) {
                    resolve("تعذر تحليل استجابة الذكاء الاصطناعي.");
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(data);
        req.end();
    });
}

// Run if called directly
if (require.main === module) {
    generateExplanation();
}

module.exports = { generateExplanation };
