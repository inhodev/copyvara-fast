# CopyVara Vercel Deployment Guide

코드 마이그레이션과 GitHub 업로드가 완료되었습니다. 이제 Vercel에 배포하기 위해 아래 단계를 따라주세요.

## 1. Vercel 환경 변수 설정
Vercel 프로젝트 설정(Project Settings > Environment Variables)에서 다음 항목들을 추가해 주세요.

| Key | Value | 비고 |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | `https://xgbypmmlxlihcuxrqxwy.supabase.co` | Supabase 프로젝트 URL |
| `VITE_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI... (생략)` | Supabase Anon Key |
| `OPENAI_API_KEY` | `sk-proj-... (생략)` | OpenAI API Key (Backend API에서 사용) |

> [!IMPORTANT]
> Frontend에서 환경변수를 인식하려면 반드시 **`VITE_`** 접두사가 붙어 있어야 합니다.

## 2. Vercel 빌드 설정
Vercel 프로젝트 생성 시 다음과 같이 설정해 주세요.

- **Framework Preset**: `Vite` (또는 Other)
- **Root Directory**: `./` (루트 디렉토리)
- **Build Command**: `npm run build` (또는 `cd frontend-minimal && npm install && npm run build`)
- **Output Directory**: `frontend-minimal/dist`

> [!NOTE]
> 프로젝트 루트에 `vercel.json`을 추가해 두었으므로, Vercel이 자동으로 `/api` 경로와 Frontend 빌드를 연결할 것입니다.

## 3. 추가 확인 사항 (Supabase RLS)
현재 RLS(Row Level Security)가 활성화되어 있다면, 클라이언트에서 직접 데이터를 읽고 쓸 수 있도록 정책을 설정해야 합니다.

- **`documents` 테이블**: `anon` 역할에 대해 `SELECT`, `INSERT` 권한 허용
- **`qa_history` 테이블**: `anon` 역할에 대해 `SELECT`, `INSERT` 권한 허용

## 4. GitHub 연동
GitHub 저장소(`git@github.com:inhodev/copyvara-fast.git`)를 Vercel에 연결하면 push 할 때마다 자동으로 배포됩니다.
