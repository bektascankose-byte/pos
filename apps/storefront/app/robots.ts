import type { MetadataRoute } from "next";

/** Keep private pages out of search results. A sitemap arrives with the SEO work. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/cart", "/checkout", "/account", "/track", "/age-check", "/api", "/search"],
    },
  };
}
