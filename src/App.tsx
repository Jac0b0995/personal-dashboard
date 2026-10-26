import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { runFullSync } from './lib/syncEngine';
import { useSession } from './lib/auth';
import Header from './components/Header';
import BriefingWidget from './components/BriefingWidget';
import WeatherWidget from './components/WeatherWidget';
import TasksWidget from './components/TasksWidget';
import FinanceWidget from './components/FinanceWidget';
import InstallPrompt from './components/InstallPrompt';
import AuthModal from './components/AuthModal';
import { Home, CheckSquare, DollarSign, Newspaper } from 'lucide-react';

export default function App() {
  const queryClient = useQueryClient();
  const { session, loading: authLoading } = useSession();
  const [authOpen, setAuthOpen] = useState(false);
  const promptedRef = useRef(false);

  // Offer sign-in once per page load if nobody is signed in.
  useEffect(() => {
    if (authLoading || promptedRef.current) return;
    promptedRef.current = true;
    if (!session) setAuthOpen(true);
  }, [authLoading, session]);

  // Close the modal whenever a session appears (including from another tab).
  useEffect(() => {
    if (session) setAuthOpen(false);
  }, [session]);

  useEffect(() => {
    const triggerSync = () => {
      void runFullSync().then((summary) => {
        if (summary.pulledCount > 0 || summary.syncedCount > 0) {
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          queryClient.invalidateQueries({ queryKey: ['expenses'] });
          queryClient.invalidateQueries({ queryKey: ['executive-briefing'] });
        }
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        triggerSync();
      }
    };

    // Trigger on initial mount
    triggerSync();

    // Event Listeners for network re-connection and tab switching
    window.addEventListener('online', triggerSync);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('online', triggerSync);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [queryClient]);

  const handleRefresh = async () => {
    const summary = await runFullSync();
    if (summary.pulledCount > 0 || summary.syncedCount > 0) {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['expenses'] });
    }
    // Force refetch external live endpoints and briefing synthesis
    queryClient.invalidateQueries({ queryKey: ['weather-and-aqi'] });
    queryClient.invalidateQueries({ queryKey: ['exchange-rate'] });
    queryClient.invalidateQueries({ queryKey: ['executive-briefing'] });
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 pb-24 md:pb-8 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <Header
        onRefresh={handleRefresh}
        onSignInClick={() => setAuthOpen(true)}
      />

      <main className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {/* Card 1: AI Executive Briefing */}
        <div className="md:col-span-2 bg-slate-800/80 border border-slate-700/50 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <BriefingWidget />
        </div>

        {/* Card 2: Weather & Environment */}
        <div className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <WeatherWidget />
        </div>

        {/* Card 3: Gamified Tasks & Leveling */}
        <div className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <TasksWidget />
        </div>

        {/* Card 4: Financial Tracker & USD/COP */}
        <div className="bg-slate-800/80 border border-slate-700/50 rounded-2xl p-5 shadow-lg backdrop-blur-sm">
          <FinanceWidget />
        </div>
      </main>

      {/* Mobile Sticky Navigation Bar */}
      <nav className="fixed bottom-0 left-0 right-0 md:hidden bg-slate-900/95 border-t border-slate-800 backdrop-blur-md px-6 py-3 flex justify-around items-center z-50">
        <button className="flex flex-col items-center gap-1 text-indigo-400">
          <Home className="w-5 h-5" />
          <span className="text-[10px] font-medium">Home</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200">
          <CheckSquare className="w-5 h-5" />
          <span className="text-[10px] font-medium">Tasks</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200">
          <DollarSign className="w-5 h-5" />
          <span className="text-[10px] font-medium">Finance</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-200">
          <Newspaper className="w-5 h-5" />
          <span className="text-[10px] font-medium">News</span>
        </button>
      </nav>

      {/* PWA Custom Install Banner */}
      <InstallPrompt />

      {/* Auth modal: rendered last so it stacks above the nav (both z-50) */}
      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}