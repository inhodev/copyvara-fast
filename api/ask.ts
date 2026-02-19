import { OpenAI } from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!
);

export default async function handler(req: any, res: any) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { question } = req.body;

    if (!question) {
        return res.status(400).json({ error: 'Missing question' });
    }

    try {
        // 1. Fetch recent 20 docs
        const { data: docs, error } = await supabase
            .from('documents')
            .select('title, summary, tags')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        // 2. Filter/Logic (Simple version handles context injection)
        const context = docs?.map((d, i) => `${i + 1}) ${d.title}: ${d.summary}`).join('\n') || '저장된 지식이 없습니다.';

        const systemPrompt = `당신은 지식 관리 비서입니다. 제공된 지식을 바탕으로 질문에 답변하세요.
질문: ${question}

저장된 지식 요약:
${context}

위 지식만을 근거로 친절하게 한국어로 답변하세요. 근거가 없으면 모른다고 하세요.`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: systemPrompt }],
        });

        const answer = response.choices[0].message.content || '답변을 생성할 수 없습니다.';

        // 3. QA 내역 저장
        await supabase.from('qa_history').insert([{ question, answer }]);

        return res.status(200).json({ answer });
    } catch (error: any) {
        console.error('API Error:', error);
        return res.status(500).json({ error: error.message });
    }
}
