import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  type: 'succes' | 'erreur' | 'info';
  texte: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly messages = signal<Toast[]>([]);
  private compteur = 0;

  succes(texte: string): void {
    this.ajouter('succes', texte);
  }

  erreur(texte: string): void {
    this.ajouter('erreur', texte);
  }

  info(texte: string): void {
    this.ajouter('info', texte);
  }

  private ajouter(type: Toast['type'], texte: string): void {
    const id = ++this.compteur;
    this.messages.update((liste) => [...liste, { id, type, texte }]);
    setTimeout(() => this.fermer(id), type === 'erreur' ? 7000 : 4000);
  }

  fermer(id: number): void {
    this.messages.update((liste) => liste.filter((t) => t.id !== id));
  }
}
