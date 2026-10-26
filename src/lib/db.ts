import Dexie, { type Table } from 'dexie';

export interface LocalTask {
  id?: string;
  title: string;
  category: string;
  due_date?: string;
  status: 'pending' | 'completed' | 'postponed';
  priority: 'low' | 'medium' | 'high';
  deleted?: boolean;
  postpone_count: number;
  xp_reward: number;
  synced: boolean; // Tracking flag for offline sync engine
}

export interface LocalExpense {
  id?: string;
  description: string;
  amount: number;
  currency: string;
  category: string;
  expense_date: string;
  synced: boolean;
  deleted?: boolean;
}

export interface LocalHabit {
  id?: string;
  title: string;
  frequency: string;
  streak_count: number;
  last_completed_at?: string;
  synced: boolean;
}

export interface LocalWeatherCache {
  id?: string;
  city: string;
  temp: number;
  condition: string;
  aqi: number;
  updated_at: string;
}

export class PersonalDashboardDB extends Dexie {
  tasks!: Table<LocalTask>;
  expenses!: Table<LocalExpense>;
  habits!: Table<LocalHabit>;
  weatherCache!: Table<LocalWeatherCache>;

  constructor() {
    super('PersonalDashboardDB');
    this.version(1).stores({
      tasks: '++id, status, category, synced',
      expenses: '++id, category, expense_date, synced',
      habits: '++id, synced',
      weatherCache: '++id, city, updated_at'
    });
  }
}

export const db = new PersonalDashboardDB();