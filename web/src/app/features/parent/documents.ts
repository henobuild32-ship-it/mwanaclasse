import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { Chargement, EtatVide } from '../../shared/ui';

interface Document {
  id: string;
  category?: string | null;
  title: string;
  description?: string | null;
  file_url?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  created_at?: string;
  ecole?: string | null;
}

/** Documents mis à disposition par l'école (spec §6). */
@Component({
  selector: 'app-documents-parent',
  imports: [SlicePipe, Chargement, EtatVide],
  templateUrl: './documents.html',
  styleUrl: './pages.scss',
})
export class DocumentsParent {
  private readonly api = inject(ApiService);

  protected readonly documents = signal<Document[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ documents: Document[] }>('parent/documents');
      this.documents.set(r.documents ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : documents indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected taille(o: Document): string {
    const s = o.file_size ?? 0;
    if (s > 1_048_576) return `${(s / 1_048_576).toFixed(1)} Mo`;
    if (s > 1024) return `${Math.round(s / 1024)} Ko`;
    return `${s} o`;
  }
}
