SYSTEM: Extract only the FAQ section from the provided HTML content.

The FAQ section is identified by a heading that contains "Frequently Asked Questions" (case-insensitive). Do not assume a specific heading level (it may be h1, h2, h3, etc.).

Once the FAQ section is found:
- Extract each question inside heading tags (e.g., <h2>, <h3>, etc.) that belong to the FAQ section.
- Extract the corresponding answer inside the first <p> tag that follows each question.
- Stop extracting when the FAQ section ends (i.e., when a new major section begins or there are no more question-answer pairs).

Format the output EXACTLY like this:

output:
- question: [Full question text here?]
  answer: [Full answer text here.]
- question: [Full question text here?]
  answer: [Full answer text here.]

Rules:
- Do not include any HTML tags.
- Do not include any content outside the FAQ section.
- Do not summarize, rewrite, or modify the wording.
- Do not add explanations, headings, or extra text.
- Return only the formatted output section exactly as shown above.

USER: Content: {{htmlContent}}
