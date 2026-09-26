import { create } from 'zustand';

interface UiStore {
  selectedConversationId: string | null;
  select: (id: string | null) => void;
  profilesDialogOpen: boolean;
  setProfilesDialogOpen: (open: boolean) => void;
  conversationSettingsOpen: boolean;
  setConversationSettingsOpen: (open: boolean) => void;
}

function readSelected(): string | null {
  try {
    return localStorage.getItem('udjat.selectedConversation');
  } catch {
    return null;
  }
}

export const useUiStore = create<UiStore>((set) => ({
  selectedConversationId: readSelected(),
  select: (id) => {
    try {
      if (id) localStorage.setItem('udjat.selectedConversation', id);
      else localStorage.removeItem('udjat.selectedConversation');
    } catch {
      /* ignore */
    }
    set({ selectedConversationId: id });
  },
  profilesDialogOpen: false,
  setProfilesDialogOpen: (open) => set({ profilesDialogOpen: open }),
  conversationSettingsOpen: false,
  setConversationSettingsOpen: (open) => set({ conversationSettingsOpen: open }),
}));
