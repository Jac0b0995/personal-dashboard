# Personal Dashboard - System Architecture & Context

## 1. Project Overview
A budget-friendly ($0/mo operating cost) mobile-first Progressive Web Application (PWA) serving as a daily morning dashboard for an engineering student, community manager, and DJ/producer.

## 2. Tech Stack
- **Frontend:** Vite + React + TypeScript + Tailwind CSS + shadcn/ui
- **PWA Engine:** `vite-plugin-pwa`, Service Workers, Web App Manifest
- **Backend Proxy:** Vercel Serverless Functions (`/api/*`)
- **Database & Auth:** Supabase (PostgreSQL) + Row-Level Security (RLS)
- **State & Caching:** TanStack Query + Dexie.js (IndexedDB local-first storage)
- **AI Engine:** Google AI Studio (Gemini 2.5/3.5 Flash API via Serverless Proxy)

## 3. Core Modules
1. Gamified Task & Academic Tracker (XP, level calculation, postpone matrix)
2. iCal Multi-Calendar Feed Parser (Google/Apple Calendar aggregation)
3. Financial Tracker & USD/COP Exchange Rate Monitor
4. RSS News Engine (Gaming, Music/Audio, Tech/AI, Personal Growth)
5. Weather & Air Quality Widget
6. Gemini AI Morning Executive Summary (Data anonymized via proxy)