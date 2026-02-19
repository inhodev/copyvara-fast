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

  const { raw_text } = req.body;

  if (!raw_text) {
    return res.status(400).json({ error: 'Missing raw_text' });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 지식 관리 도우미입니다. 입력된 텍스트를 구조화하여 JSON 형식으로 반환하세요.
특히 지식 시각화와 실무 적용을 위해 다음 정보를 반드시 포함해야 합니다:
1. Graph: 핵심 개념(nodes)과 관계(edges)
2. Timeline: 주요 사건/단계와 시점(period/date)
3. Topic Map: 주제분류(category)와 세부항목(topics)
4. Strategy Quadrant: 2축 기반 배치 (x: 중요도, y: 시급성, 0~100)
5. Action Plan: 실무 적용을 위한 구체적인 목표와 실행 단계

반환 형식:
{
  "title": "제목 (최대한 간결하게)",
  "summary": "3~5줄 요약",
  "bullets": ["핵심 포인트 1", "핵심 포인트 2", "핵심 포인트 3", "핵심 포인트 4"],
  "tags": ["태그1", "태그2", "태그3"],
  "action_plan": {
    "goal": "이 지식을 통해 달성하려는 핵심 목표",
    "steps": [{"step": "단계명", "description": "상세 실행 내용", "priority": "High|Medium|Low"}],
    "applications": [{"context": "적용 상황", "suggestion": "구체적 적용 방법"}]
  },
  "viz_data": {
    "graph": { "nodes": [{"id": "id1", "label": "개념1"}], "edges": [{"source": "id1", "target": "id2", "relation": "관계"}] },
    "timeline": [{"event": "사건1", "date": "시점/기간", "description": "설명"}],
    "topic_map": [{"category": "분류1", "topics": ["주제1", "주제2"]}],
    "quadrant": [{"label": "항목1", "x": 80, "y": 90, "reason": "이유"}]
  }
}`,
        },
        {
          role: 'user',
          content: raw_text,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');

    // 자동 저장 (Supabase)
    const { data: savedDoc, error: saveError } = await supabase
      .from('documents')
      .insert([
        {
          title: result.title,
          raw_text: raw_text,
          summary: result.summary,
          bullets: result.bullets,
          tags: result.tags,
          viz_data: result.viz_data,
          action_plan: result.action_plan
        }
      ])
      .select()
      .single();

    if (saveError) {
      console.error('Save Error:', saveError);
    }

    return res.status(200).json({ ...result, id: savedDoc?.id });
  } catch (error: any) {
    console.error('OpenAI Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
