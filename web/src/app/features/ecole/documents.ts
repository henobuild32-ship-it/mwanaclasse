import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

interface Document {
  id: string;
  category?: string | null;
  title: string;
  description?: string | null;
  file_url?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  visibility?: string;
  audience_kind?: string;
  downloads?: number;
  is_active?: boolean;
  uploaded_by_name?: string | null;
  created_at?: string;
}

/** Documents de l'école (spécimens, bulletins, formulaires). */
@Component({
  selector: 'app-documents-ecole',
  imports: [SlicePipe, Chargement, EtatVide, Etiquette],
  templateUrl: './documents.html',
  styleUrl: './pages.scss',
})
export class DocumentsEcole {
  private readonly api = inject(ApiService);
  protected readonly etiquetteStatut = etiquetteStatut;

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
      const r = await this.api.lire<{ documents: Document[] }>('ecole/documents');
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
