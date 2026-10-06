import { Injectable, inject } from '@angular/core';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from 'docx';
import { saveAs } from 'file-saver';
import { SessionService } from './session.service';
import { ApiService, toApiError } from './api.service';
import { Chargement } from '../shared/ui';

export interface PresenceExportData {
  date: string;
  classe: string;
  section?: string;
  ecole: string;
  eleves: {
    id: string;
    publicCode: string;
    nom: string;
    genre: string;
    statut: string;
    heureArrivee?: string;
    heureDepart?: string;
    motif?: string;
  }[];
  stats: {
    total: number;
    presents: number;
    absents: number;
    retards: number;
    depants: number;
  };
}

@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly session = inject(SessionService);
  private readonly api = inject(ApiService);

  /** Génère un PDF de la liste de présence */
  async genererPDF(donnees: PresenceExportData): Promise<void> {
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const marge = 15;
    let y = marge;

    // En-tête école
    const primaryColor = this.session.ecole()?.couleur ?? '#1d4ed8';
    pdf.setFillColor(primaryColor);
    pdf.rect(0, 0, 210, 25, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(18);
    pdf.setFont('helvetica', 'bold');
    pdf.text(donnees.ecole, 15, 16);

    // Titre du document
    y = 32;
    pdf.setTextColor(0, 0, 0);
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Liste de présence', 15, y);
    y += 8;
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(80, 80, 80);
    pdf.text(`${donnees.classe}${donnees.section ? ' / ' + donnees.section : ''} — ${this.formaterDate(donnees.date)}`, 15, y);

    // Statistiques
    y += 10;
    const stats = donnees.stats;
    pdf.setDrawColor(200, 200, 200);
    pdf.setLineWidth(0.3);
    pdf.rect(15, y, 180, 12, 'S');
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(0, 0, 0);
    const cols = [
      { label: 'Total', val: stats.total, x: 18 },
      { label: 'Présents', val: stats.presents, x: 55 },
      { label: 'Absents', val: stats.absents, x: 95 },
      { label: 'Retards', val: stats.retards, x: 135 },
      { label: 'Dép. ant.', val: stats.depants, x: 170 },
    ];
    for (const c of cols) {
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(c.label, c.x, y + 5);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(0, 0, 0);
      pdf.text(String(c.val), c.x, y + 10);
    }

    // Tableau des élèves
    y += 18;
    const headers = ['Code', 'Nom complet', 'Genre', 'Statut', 'Arrivée', 'Départ', 'Motif'];
    const colWidths = [18, 55, 14, 22, 22, 22, 30];
    let xStart = 15;

    // En-tête tableau
    pdf.setFillColor(40, 40, 40);
    pdf.rect(xStart, y, 180, 8, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'bold');
    let cx = xStart;
    for (let i = 0; i < headers.length; i++) {
      pdf.text(headers[i], cx + 1, y + 5.5);
      cx += colWidths[i];
    }

    // Lignes
    y += 8;
    pdf.setFontSize(6.5);
    pdf.setFont('helvetica', 'normal');
    let altern = false;
    for (const e of donnees.eleves) {
      if (y > 270) { pdf.addPage(); y = marge; }
      if (altern) { pdf.setFillColor(245, 245, 245); pdf.rect(xStart, y - 1, 180, 7, 'F'); }
      altern = !altern;
      pdf.setTextColor(0, 0, 0);
      const row = [
        e.publicCode,
        e.nom,
        e.genre === 'F' ? 'F' : e.genre === 'M' ? 'M' : '-',
        this.statutLabel(e.statut),
        e.heureArrivee ?? '-',
        e.heureDepart ?? '-',
        e.motif ?? '-',
      ];
      cx = xStart;
      for (let i = 0; i < row.length; i++) {
        pdf.text(this.tronquer(row[i], colWidths[i] / 1.8), cx + 1, y + 4.5);
        cx += colWidths[i];
      }
      y += 7;
    }

    // Pied de page
    const pageCount = pdf.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      pdf.setPage(i);
      pdf.setFontSize(7);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`MwanaClasse — Généré le ${new Date().toLocaleString('fr-FR')}`, 15, 290);
      pdf.text(`Page ${i} / ${pageCount}`, 185, 290, { align: 'right' });
    }

    const nomFichier = `presence_${donnees.classe}_${donnees.date.replace(/-/g, '')}.pdf`;
    pdf.save(nomFichier);
  }

  /** Génère un DOCX de la liste de présence */
  async genererDOCX(donnees: PresenceExportData): Promise<void> {
    const primaryColor = this.session.ecole()?.couleur?.replace('#', '') ?? '1d4ed8';
    const hexToRgb = (hex: string) => {
      const c = hex.replace('#', '');
      return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) };
    };
    const { r, g, b } = hexToRgb(primaryColor);

    const rows = [
      new TableRow({
        children: [
          'Code', 'Nom complet', 'Genre', 'Statut', 'Arrivée', 'Départ', 'Motif'
        ].map(t => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, size: 18, color: 'FFFFFF' })] })],
          shading: { fill: primaryColor },
        })),
      }),
      ...donnees.eleves.map((e, idx) => new TableRow({
        children: [
          e.publicCode,
          e.nom,
          e.genre === 'F' ? 'F' : e.genre === 'M' ? 'M' : '-',
          this.statutLabel(e.statut),
          e.heureArrivee ?? '-',
          e.heureDepart ?? '-',
          e.motif ?? '-',
        ].map(t => new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: t, size: 18 })] })],
          shading: { fill: idx % 2 === 0 ? 'F5F5F5' : 'FFFFFF' },
        })),
      })),
    ];

    const doc = new Document({
      sections: [{
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: donnees.ecole, bold: true, size: 32, color: primaryColor }),
            ],
          }),
          new Paragraph({ text: '', spacing: { after: 120 } }),
          new Paragraph({
            children: [
              new TextRun({ text: 'Liste de présence', bold: true, size: 28 }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `${donnees.classe}${donnees.section ? ' / ' + donnees.section : ''} — ${this.formaterDate(donnees.date)}`, size: 20, color: '666666' }),
            ],
          }),
          new Paragraph({ text: '', spacing: { after: 200 } }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows,
          }),
          new Paragraph({ text: '', spacing: { after: 400 } }),
          new Paragraph({
            children: [
              new TextRun({ text: 'Statistiques :', bold: true, size: 20 }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Total: ${donnees.stats.total}  •  Présents: ${donnees.stats.presents}  •  Absents: ${donnees.stats.absents}  •  Retards: ${donnees.stats.retards}  •  Départs anticipés: ${donnees.stats.depants}`, size: 18 }),
            ],
          }),
          new Paragraph({ text: '', spacing: { after: 400 } }),
          new Paragraph({
            children: [
              new TextRun({ text: `MwanaClasse — Généré le ${new Date().toLocaleString('fr-FR')}`, size: 16, color: '999999' }),
            ],
          }),
        ],
      }],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, `presence_${donnees.classe}_${donnees.date.replace(/-/g, '')}.docx`);
  }

  /** Récupère les données de présence via l'API et les formate pour l'export */
  async preparerExport(date: string, classeId: string, sectionId?: string): Promise<PresenceExportData> {
    const schoolId = this.session.ecole()?.id;
    if (!schoolId) throw new Error('Aucune école connectée');

    const [presence, classe, ecole] = await Promise.all([
      this.api.lire<{ eleves: any[]; recap: any }>(`ecole/presences?date=${date}&classeId=${classeId}${sectionId ? '&sectionId=' + sectionId : ''}`),
      this.api.lire<any>(`ecole/classes/${classeId}`),
      this.api.lire<any>(`ecole/parametres`),
    ]);

    const eleves = presence.eleves.map((e: any) => ({
      id: e.student_id,
      publicCode: e.public_code,
      nom: e.full_name,
      genre: e.gender,
      statut: e.status,
      heureArrivee: e.arrival_time,
      heureDepart: e.departure_time,
      motif: e.reason,
    }));

    const stats = presence.recap;

    return {
      date,
      classe: classe.name,
      section: classe.section?.name,
      ecole: ecole.ecole?.official_name ?? 'École',
      eleves,
      stats: {
        total: stats.total,
        presents: stats.presents,
        absents: stats.absents,
        retards: stats.retards,
        depants: stats.depants,
      },
    };
  }

  private statutLabel(s: string): string {
    const map: Record<string, string> = {
      present: 'Présent',
      absent: 'Absent',
      retard: 'Retard',
      depart_anticipe: 'Départ ant.',
      non_enregistre: 'Non enr.',
    };
    return map[s] ?? s;
  }

  private formaterDate(d: string): string {
    return new Date(d + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  private tronquer(t: string, max: number): string {
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
}