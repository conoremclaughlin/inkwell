/**
 * Google Docs Service
 *
 * Handles Google Docs API interactions using OAuth tokens
 * managed by the OAuthService.
 */

import { google, docs_v1 } from 'googleapis';
import { getOAuthService } from '../../services/oauth';
import { logger } from '../../utils/logger';
import type {
  AppendTextOptions,
  CreateDocumentOptions,
  DocumentContent,
  DocumentSummary,
  GetDocumentOptions,
  ReplaceTextOptions,
  ReplaceTextResult,
} from './types';

const DOCS_BASE_URL = 'https://docs.google.com/document/d/';

export class GoogleDocsService {
  private oauthService = getOAuthService();

  private async getClient(userId: string): Promise<docs_v1.Docs> {
    const accessToken = await this.oauthService.getValidAccessToken(userId, 'google');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });

    return google.docs({ version: 'v1', auth });
  }

  async createDocument(userId: string, options: CreateDocumentOptions): Promise<DocumentSummary> {
    const docs = await this.getClient(userId);

    logger.info('Creating Google Doc', { userId, title: options.title });

    const created = await docs.documents.create({
      requestBody: { title: options.title },
    });

    const documentId = created.data.documentId || '';

    if (options.initialContent && documentId) {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: options.initialContent,
              },
            },
          ],
        },
      });
    }

    return this.toSummary({
      documentId,
      title: created.data.title || options.title,
      revisionId: created.data.revisionId || undefined,
    });
  }

  async getDocument(userId: string, options: GetDocumentOptions): Promise<DocumentContent> {
    const docs = await this.getClient(userId);

    logger.info('Fetching Google Doc', { userId, documentId: options.documentId });

    const response = await docs.documents.get({ documentId: options.documentId });
    const data = response.data;

    return {
      ...this.toSummary({
        documentId: data.documentId || options.documentId,
        title: data.title || '',
        revisionId: data.revisionId || undefined,
      }),
      text: this.extractPlainText(data.body),
    };
  }

  async appendText(userId: string, options: AppendTextOptions): Promise<DocumentSummary> {
    const docs = await this.getClient(userId);

    const separateWithNewline = options.separateWithNewline ?? true;

    logger.info('Appending text to Google Doc', {
      userId,
      documentId: options.documentId,
      length: options.text.length,
      separateWithNewline,
    });

    const doc = await docs.documents.get({
      documentId: options.documentId,
      fields: 'body(content(endIndex)),title,revisionId,documentId',
    });

    const endIndex = this.findBodyEndIndex(doc.data.body);
    // Doc end index is exclusive — the API requires inserting at endIndex - 1
    // because the body always ends with a trailing newline that owns the last index.
    const insertionIndex = Math.max(1, endIndex - 1);

    const text = separateWithNewline ? `\n${options.text}` : options.text;

    await docs.documents.batchUpdate({
      documentId: options.documentId,
      requestBody: {
        requests: [
          {
            insertText: {
              location: { index: insertionIndex },
              text,
            },
          },
        ],
      },
    });

    return this.toSummary({
      documentId: options.documentId,
      title: doc.data.title || '',
      revisionId: doc.data.revisionId || undefined,
    });
  }

  async replaceText(userId: string, options: ReplaceTextOptions): Promise<ReplaceTextResult> {
    const docs = await this.getClient(userId);

    const matchCase = options.matchCase ?? true;

    logger.info('Replacing text in Google Doc', {
      userId,
      documentId: options.documentId,
      matchCase,
    });

    const response = await docs.documents.batchUpdate({
      documentId: options.documentId,
      requestBody: {
        requests: [
          {
            replaceAllText: {
              containsText: { text: options.find, matchCase },
              replaceText: options.replaceWith,
            },
          },
        ],
      },
    });

    const reply = response.data.replies?.[0]?.replaceAllText;
    return {
      documentId: options.documentId,
      occurrencesChanged: reply?.occurrencesChanged || 0,
    };
  }

  private toSummary(input: {
    documentId: string;
    title: string;
    revisionId?: string;
  }): DocumentSummary {
    return {
      documentId: input.documentId,
      title: input.title,
      url: input.documentId ? `${DOCS_BASE_URL}${input.documentId}/edit` : '',
      revisionId: input.revisionId,
    };
  }

  private findBodyEndIndex(body: docs_v1.Schema$Body | undefined): number {
    const content = body?.content || [];
    if (content.length === 0) return 1;
    const last = content[content.length - 1];
    return last.endIndex || 1;
  }

  private extractPlainText(body: docs_v1.Schema$Body | undefined): string {
    const elements = body?.content || [];
    let out = '';

    for (const element of elements) {
      if (element.paragraph) {
        for (const run of element.paragraph.elements || []) {
          if (run.textRun?.content) {
            out += run.textRun.content;
          }
        }
      } else if (element.table) {
        for (const row of element.table.tableRows || []) {
          for (const cell of row.tableCells || []) {
            for (const cellEl of cell.content || []) {
              for (const run of cellEl.paragraph?.elements || []) {
                if (run.textRun?.content) {
                  out += run.textRun.content;
                }
              }
            }
            out += '\t';
          }
          out += '\n';
        }
      }
    }

    return out;
  }
}

let docsService: GoogleDocsService | null = null;

export function getGoogleDocsService(): GoogleDocsService {
  if (!docsService) {
    docsService = new GoogleDocsService();
  }
  return docsService;
}
