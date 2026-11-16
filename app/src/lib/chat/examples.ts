// Example questions shown as buttons. Client-safe; answers come from example-answers.ts on the server.

export const EXAMPLE_QUESTIONS = [
  { id: "pantanal-aug-2024", question: "Was August 2024 unusual for the Pantanal?" },
  { id: "w-canada-top-year", question: "Which year burned most in Western Canada?" },
  { id: "punjab-peak-month", question: "What is the peak fire month in Punjab?" },
  { id: "this-month", question: "How does this month compare to normal?" },
  { id: "pantanal-2024-year", question: "Was 2024 a big fire year for the Pantanal?" },
  { id: "pantanal-worst-month", question: "What was the worst month on record in the Pantanal?" },
] as const;

export type ExampleId = (typeof EXAMPLE_QUESTIONS)[number]["id"];

export function isExampleId(id: string): id is ExampleId {
  return EXAMPLE_QUESTIONS.some((q) => q.id === id);
}
