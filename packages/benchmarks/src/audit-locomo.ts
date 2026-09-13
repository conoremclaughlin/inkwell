import { buildLoCoMoSourceDocuments, loadLoCoMoCorpus } from './benchmark-data/locomo-loader';

async function main(): Promise<void> {
  const corpus = await loadLoCoMoCorpus();
  const turnDocuments = corpus.samples.flatMap((sample) =>
    buildLoCoMoSourceDocuments(sample, 'turn')
  );
  const sessionDocuments = corpus.samples.flatMap((sample) =>
    buildLoCoMoSourceDocuments(sample, 'session')
  );
  const warnings = corpus.samples.flatMap((sample) =>
    sample.questions
      .filter(
        (question) =>
          question.repairedEvidence.length > 0 ||
          question.unresolvedEvidenceIds.length > 0 ||
          question.malformedEvidence.length > 0
      )
      .map((question) => ({
        sampleId: sample.sampleId,
        questionId: question.questionId,
        category: question.categoryName,
        repairedEvidence: question.repairedEvidence,
        unresolvedEvidenceIds: question.unresolvedEvidenceIds,
        malformedEvidence: question.malformedEvidence,
      }))
  );

  console.log(
    JSON.stringify(
      {
        source: corpus.source,
        datasetSha256: corpus.datasetSha256,
        audit: corpus.audit,
        representations: {
          rawTurn: {
            documents: turnDocuments.length,
            totalCharacters: turnDocuments.reduce(
              (sum, document) => sum + document.content.length,
              0
            ),
            maxCharacters: Math.max(...turnDocuments.map((document) => document.content.length)),
          },
          rawSession: {
            documents: sessionDocuments.length,
            totalCharacters: sessionDocuments.reduce(
              (sum, document) => sum + document.content.length,
              0
            ),
            maxCharacters: Math.max(...sessionDocuments.map((document) => document.content.length)),
          },
        },
        evidenceWarnings: warnings,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[locomo-audit] failed:', error);
  process.exit(1);
});
