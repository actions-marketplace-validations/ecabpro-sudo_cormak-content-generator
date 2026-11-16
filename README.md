# Cormak Content Generator

Turn one topic or product brief into a Markdown draft in a GitHub Actions
workspace. The Action calls Cormak's Blog API for articles and SEO articles, or
the Store API for factual product copy with SEO metadata. It runs on Node 24
with no runtime packages.

**Release candidate:** use the checked-in mock tests while the repository and
Marketplace listing are being prepared.

## Set up

Follow [the OAuth connection guide](CONNECTION.md). Consent to `blog:use` for
articles and `store:use` for product copy. The helper requests both to support
all three modes. The [article](examples/article.yml), [SEO](examples/seo.yml)
and [product](examples/product.yml) workflows show a full manual run and
short-lived artifact upload. For sample inputs, see [the demo](demo/README.md).

| Input | Purpose |
| --- | --- |
| `kind` | `article` (default), `seo`, or `product`. |
| `topic` | Article topic (3–200 characters) or product name (2–200). |
| `keywords` | For SEO, comma-separated phrases (up to 12). |
| `product_facts` | Required for product mode; verified facts only. |
| `words`, `style`, `audience` | Article controls, see [metadata](action.yml). |
| `tone`, `language` | Product tone and output language; language also applies to articles. |
| `request_id`, `allow_paid`, `max_credits` | Stable UUID, explicit opt-in and credit ceiling. |
| `output_path` | New `.md` file below `generated/`. Default: `generated/content.md`. |

Outputs: `request_id`, `status`, `output_path` and `credits_charged` when
returned by Cormak. Files are saved in the checkout; no commit is created.
Article headings and lists are preserved; outbound links and raw HTML are
omitted. Review SEO fields before moving them into CMS front matter.

The Action reads the current quote and checks the full article price, even
when the quote includes a trial article: another job can consume that trial
before this job runs. Pricing, limits and refunds are owned by Cormak. A quote
change stops generation; review the new quote before retrying. Product text
uses the Store's current text price; the stable UUID deduplicates identical
Store requests.

Run offline tests: `node --test test.mjs oauth.test.mjs`.
