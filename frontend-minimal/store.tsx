import React, { createContext, useContext, useState, useEffect } from 'react';
import { Document, DocumentStatus, LinkStatus, LinkCandidate, Edge, Node, MemoryItem, QASession } from './types';
import { analyzeInput, askQuestion as askQuestionApi, fetchPersistedDocuments, fetchQAHistory } from './services/geminiService';

const IS_DEV = import.meta.env.DEV;

interface AppState {
  documents: Document[];
  candidates: LinkCandidate[];
  edges: Edge[];
  nodes: Node[];
  memoryItems: MemoryItem[];
  qaSessions: QASession[];
  questionHistory: string[];
  lastError: string | null;
  addDocument: (input: string) => Promise<void>;
  acceptCandidate: (candidateId: string) => void;
  rejectCandidate: (candidateId: string) => void;
  askQuestion: (question: string) => Promise<void>;
  deleteEdge: (edgeId: string) => void;
  updateEdge: (edgeId: string, newRelation: string) => void;
  resetWorkspace: () => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

const STORAGE_KEYS = {
  documents: 'copyvara.documents.v1',
  candidates: 'copyvara.candidates.v1',
  edges: 'copyvara.edges.v1',
  memoryItems: 'copyvara.memoryItems.v1',
  qaSessions: 'copyvara.qaSessions.v1',
  questionHistory: 'copyvara.questionHistory.v1'
} as const;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenize = (text: string): string[] => normalize(text).split(' ').filter(token => token.length > 1);

const overlapRatio = (queryTokens: string[], targetText: string): number => {
  if (queryTokens.length === 0) return 0;
  const targetTokens = new Set(tokenize(targetText));
  let overlap = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.length;
};

const recencyScore = (createdAt?: string): number => {
  if (!createdAt) return 0.4;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (Number.isNaN(ageMs) || ageMs <= 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0.1, 1 - Math.min(ageDays, 30) / 30);
};

const buildMemoryItemsFromDoc = (doc: Document): MemoryItem[] => {
  const now = new Date().toISOString();
  const items: MemoryItem[] = [];

  if (doc.summaryText) {
    items.push({
      id: `mem-${doc.id}-summary`,
      documentId: doc.id,
      title: `${doc.title} 요약`,
      category: 'summary',
      content: doc.summaryText,
      tags: doc.topicTags || [],
      createdAt: now,
      updatedAt: now
    });
  }

  (doc.summaryBullets || []).slice(0, 5).forEach((bullet, idx) => {
    items.push({
      id: `mem-${doc.id}-fact-${idx}`,
      documentId: doc.id,
      title: `${doc.title} 핵심 포인트 ${idx + 1}`,
      category: 'fact',
      content: bullet,
      tags: doc.topicTags || [],
      createdAt: now,
      updatedAt: now
    });
  });

  (doc.actionPlan?.steps || []).slice(0, 3).forEach((step, idx) => {
    items.push({
      id: `mem-${doc.id}-action-${idx}`,
      documentId: doc.id,
      title: `${doc.title} 실행 ${idx + 1}`,
      category: 'action',
      content: `${step.step}: ${step.description}`,
      tags: doc.topicTags || [],
      createdAt: now,
      updatedAt: now
    });
  });

  (doc.segments || []).slice(0, 5).forEach((seg, idx) => {
    items.push({
      id: `mem-${doc.id}-segment-${idx}`,
      documentId: doc.id,
      title: `${doc.title} / ${seg.topic}`,
      category: 'segment',
      content: seg.content,
      tags: [...(doc.topicTags || []), seg.topic].filter(Boolean),
      createdAt: now,
      updatedAt: now
    });
  });

  return items;
};

const retrieveRelevantDocs = (
  question: string,
  docs: Document[],
  memoryItems: MemoryItem[],
  limit = 8
): Array<{ doc: Document; total: number }> => {
  if (docs.length === 0) return [];

  const qTokens = tokenize(question);
  const memoryByDoc = memoryItems.reduce<Record<string, MemoryItem[]>>((acc, item) => {
    if (!acc[item.documentId]) acc[item.documentId] = [];
    acc[item.documentId].push(item);
    return acc;
  }, {});

  const ranked = docs
    .map((doc) => {
      const memories = memoryByDoc[doc.id] || [];
      const memoryText = memories.slice(0, 8).map(m => `${m.title} ${m.content}`).join(' ');
      const lexical = overlapRatio(qTokens, `${doc.title} ${doc.summaryText || ''} ${memoryText}`);
      const tagOverlap = overlapRatio(qTokens, (doc.topicTags || []).join(' '));
      const recent = recencyScore(doc.createdAt);
      const total = lexical * 0.55 + tagOverlap * 0.25 + recent * 0.2;
      return { doc, total };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);

  return ranked.length > 0 ? ranked : docs.slice(0, limit).map((doc) => ({ doc, total: 0 }));
};

const ensureAnswerLength = (question: string, answer: string, evidenceDocs: Document[]): string => {
  if (answer.trim().length >= 500) return answer;

  const evidenceSummary = evidenceDocs.slice(0, 3).map((doc, idx) => {
    const base = doc.summaryText || doc.rawText || '';
    return `${idx + 1}) ${doc.title}: ${base.slice(0, 180)}`;
  }).join('\n');

  const supplement = `\n\n추가 설명:\n질문 "${question}"에 대해 저장된 지식을 기반으로 핵심을 더 구체화하면 다음과 같습니다.\n${evidenceSummary || '현재 연결된 문서 요약이 부족하므로, 추가 문서를 붙여넣으면 답변 정확도가 더 높아집니다.'}\n\n실행 관점에서는 (1) 질문의 키워드를 문서 태그와 맞추고, (2) 근거 문서를 2~3개 이상 교차 검증하며, (3) 결과를 바로 적용 가능한 체크리스트 형태로 정리하는 것이 효과적입니다. 이 방식은 단순 요약보다 재사용성과 신뢰도를 높여주며, 이후 후속 질문에서도 동일한 맥락을 유지하게 해줍니다.`;

  let merged = `${answer.trim()}${supplement}`;
  while (merged.length < 500) {
    merged += '\n\n보강 설명: 현재 답변은 저장된 지식 범위에서 도출된 결과이며, 관련 문서를 더 추가하면 정확도와 깊이를 함께 끌어올릴 수 있습니다.';
  }

  return merged;
};

const safeLoad = <T,>(storage: Storage, key: string, fallback: T): T => {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [candidates, setCandidates] = useState<LinkCandidate[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [qaSessions, setQaSessions] = useState<QASession[]>([]);
  const [questionHistory, setQuestionHistory] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const mergeWithLocalTransient = (persisted: Document[], current: Document[]) => {
    const transient = current.filter((d) => d.status !== DocumentStatus.Done);
    const map = new Map<string, Document>();
    [...transient, ...persisted].forEach((doc) => map.set(doc.id, doc));
    return Array.from(map.values()).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  };

  useEffect(() => {
    let active = true;

    const loadInitialData = async () => {
      try {
        const [docs, qaHistory] = await Promise.all([
          fetchPersistedDocuments(300),
          fetchQAHistory(50)
        ]);

        if (!active) return;

        setDocuments(docs);
        setQaSessions(qaHistory);

        const rebuiltMemory = docs.flatMap((doc) => buildMemoryItemsFromDoc(doc)).slice(0, 2000);
        setMemoryItems(rebuiltMemory);
      } catch (e) {
        if (!active) return;
        setLastError(e instanceof Error ? e.message : '데이터 로드 실패');
      }
    };

    loadInitialData();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const newNodes = documents.map(d => ({
      id: d.id,
      title: d.title,
      group: d.docType === 'conversation' ? 2 : 1,
      status: d.status,
      val: d.knowledgeScore, // Size node by knowledge score
      tags: d.topicTags // Pass tags for visualization
    }));
    setNodes(newNodes);
  }, [documents]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.documents, JSON.stringify(documents));
  }, [documents]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.candidates, JSON.stringify(candidates));
  }, [candidates]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.edges, JSON.stringify(edges));
  }, [edges]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.memoryItems, JSON.stringify(memoryItems));
  }, [memoryItems]);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEYS.qaSessions, JSON.stringify(qaSessions));
  }, [qaSessions]);

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEYS.questionHistory, JSON.stringify(questionHistory));
  }, [questionHistory]);

  const saveDocumentToSupabase = async (doc: Document) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/documents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          title: doc.title,
          raw_text: doc.rawText,
          summary: doc.summaryText,
          bullets: doc.summaryBullets,
          tags: doc.topicTags,
          created_at: doc.createdAt
        })
      });
      if (!response.ok) throw new Error('Supabase 저장 실패');
      return await response.json();
    } catch (e) {
      console.error('Supabase Save Error:', e);
      throw e;
    }
  };

  const addDocument = async (input: string) => {
    setLastError(null);
    const tempId = `temp-${Date.now()}`;

    // 1️⃣ 즉시 요약 시도
    const initialDoc: Document = {
      id: tempId,
      workspaceId: 'w1',
      sourceType: 'manual',
      title: 'AI 분석 중...',
      rawText: input,
      status: DocumentStatus.Processing,
      docType: 'text',
      knowledgeScore: 0,
      topicTags: [],
      createdAt: new Date().toISOString(),
    };

    setDocuments(prev => [initialDoc, ...prev]);

    try {
      // GPT 요약 호출 (백엔드에서 자동 저장됨)
      const analyzedData = await analyzeInput(input);

      const summarizedDoc: Document = {
        ...initialDoc,
        ...analyzedData,
        id: analyzedData.id || initialDoc.id, // API에서 반환한 ID 사용
        status: DocumentStatus.Done
      };

      // 2️⃣ 요약 결과 즉시 표시
      setDocuments(prev => prev.map(d => d.id === tempId ? summarizedDoc : d));

      setLastError(null);
    } catch (e) {
      console.error(e);
      setLastError(e instanceof Error ? e.message : '분석 실패');
      setDocuments(prev => prev.map(d => d.id === tempId ? {
        ...d,
        status: DocumentStatus.Failed,
        title: '분석 실패',
        summaryText: e instanceof Error ? e.message : '오류가 발생했습니다.'
      } : d));
    }
  };

  const acceptCandidate = (candidateId: string) => {
    setCandidates(prev => {
      const target = prev.find(c => c.id === candidateId);
      if (!target) return prev;
      setEdges(currentEdges => currentEdges.map(e =>
        (e.source === target.fromId && e.target === target.toId) || e.id === `e-${candidateId}`
          ? { ...e, status: 'confirmed' }
          : e
      ));
      return prev.filter(c => c.id !== candidateId);
    });
  };

  const rejectCandidate = (candidateId: string) => {
    setCandidates(prev => prev.filter(c => c.id !== candidateId));
    setEdges(prev => prev.filter(e => e.id !== `e-${candidateId}`));
  };

  const deleteEdge = (edgeId: string) => {
    setEdges(prev => prev.filter(e => e.id !== edgeId));
  };

  const updateEdge = (edgeId: string, newRelation: string) => {
    setEdges(prev => prev.map(e => e.id === edgeId ? { ...e, relation: newRelation } : e));
  };

  const askQuestion = async (question: string) => {
    setLastError(null);
    const trimmed = question.trim();
    if (trimmed.length < 2) {
      setLastError('질문을 2글자 이상 입력해 주세요.');
      return;
    }

    setQuestionHistory(prev => [trimmed, ...prev.filter(q => q !== trimmed)].slice(0, 30));

    try {
      // 3️⃣ 질문하기 (RAG 아님, 단순 컨텍스트 주입)
      const { answer } = await askQuestionApi(trimmed);

      const newSession: QASession = {
        id: `qa-${Date.now()}`,
        question: trimmed,
        answer,
        evidence: [],
        createdAt: new Date().toISOString()
      };
      setQaSessions(prev => [newSession, ...prev]);
    } catch (e) {
      const message = e instanceof Error ? e.message : '실패했습니다.';
      setLastError(message);
    }
  };

  const resetWorkspace = () => {
    setDocuments([]);
    setCandidates([]);
    setEdges([]);
    setNodes([]);
    setMemoryItems([]);
    setQaSessions([]);
    setQuestionHistory([]);
  };

  return (
    <AppContext.Provider value={{ documents, candidates, edges, nodes, memoryItems, qaSessions, questionHistory, lastError, addDocument, acceptCandidate, rejectCandidate, askQuestion, deleteEdge, updateEdge, resetWorkspace }}>
      {children}
    </AppContext.Provider>
  );
};

export const useAppStore = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error("useAppStore must be used within AppProvider");
  return context;
};
