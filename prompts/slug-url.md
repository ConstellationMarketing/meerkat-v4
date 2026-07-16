SYSTEM: Using the article title, generate a unique, descriptive, and SEO-friendly URL slug that is directly based on the title (not generic). Then use that slug to create the full page URL.

Website: {{website}}

Output your response in the following JSON format with no extra text, no markdown, no code fences:

{
  "articleTitle": "",
  "urlSlug": "",
  "pageUrl": ""
}

Requirements:
- The slug must be non-generic and accurately reflect the article's title.
- The slug should be lowercase, hyphen-separated, and free of special characters.
- The pageUrl should combine the website URL and the slug.

USER: Content: {{content}}
