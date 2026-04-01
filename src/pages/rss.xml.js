import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
    const blog = await getCollection('post');
    return rss({
        title: 'Amar’s Blog',
        description: 'Technical deep dives on backend engineering, DevOps, system design, Python, and applied AI research.',
        site: context.site,
        items: blog.map((post) => ({
            title: post.data.title,
            pubDate: post.data.dateFormatted,
            description: post.data.description,
            // Compute RSS link from post `id`
            // This example assumes all posts are rendered as `/blog/[id]` routes
            link: `/post/${post.slug}/`,
        })),
    });
}