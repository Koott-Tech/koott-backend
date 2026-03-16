const { supabaseAdmin } = require('../config/supabase');
const storageService = require('../utils/storageService');
const { 
  processStructuredContent: processContent, 
  validateStructuredContent, 
  calculateReadingTime,
  extractImagesFromContent 
} = require('../utils/blogContentProcessor');

// Helper function for consistent error responses
const errorResponse = (message, error = null, statusCode = 500) => ({
  success: false,
  message,
  error,
  statusCode
});

// Helper function for consistent success responses
const successResponse = (message, data = null) => ({
  success: true,
  message,
  data
});


// Generate slug from title
const generateSlug = (title) => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim('-');
};

// Get all blog posts
const getAllBlogs = async (req, res) => {
  try {
    const { page = 1, limit = 10, status = 'published', search = '' } = req.query;
    const offset = (page - 1) * limit;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    let query = supabaseAdmin
      .from('blogs')
      .select('*')
      .order('created_at', { ascending: false });

    // Filter by status
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    // Search functionality
    if (search) {
      query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%,excerpt.ilike.%${search}%`);
    }

    // For public access, only show published blogs
    if (!req.user || req.user.role === 'client') {
      query = query.eq('status', 'published');
    }

    const { data: blogs, error } = await query;
    
    if (error) throw error;

    // Get total count for pagination
    const { count, error: countError } = await supabaseAdmin
      .from('blogs')
      .select('*', { count: 'exact', head: true })
      .eq(status && status !== 'all' ? 'status' : 'id', status && status !== 'all' ? status : '*');

    // Transform blog data
    const formattedBlogs = blogs.map(blog => ({
      ...blog,
      featured_image_url: blog.featured_image_url || '/mainlogo.webp',
      tags: blog.tags || [],
      read_time_minutes: blog.read_time_minutes || 5
    }));

    res.json(successResponse('Blogs retrieved successfully', {
      blogs: formattedBlogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || formattedBlogs.length,
        totalPages: Math.ceil((count || formattedBlogs.length) / limit)
      }
    }));
  } catch (error) {
    console.error('Error fetching blogs:', error);
    res.status(500).json(errorResponse('Failed to fetch blogs', error.message));
  }
};

// Get blog by slug (public)
const getBlogBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: blog, error } = await supabaseAdmin
      .from('blogs')
      .select('*')
      .eq('slug', slug)
      .eq('status', 'published')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json(errorResponse('Blog post not found'));
      }
      throw error;
    }

    // Increment view count
    await supabaseAdmin
      .from('blogs')
      .update({ view_count: (blog.view_count || 0) + 1 })
      .eq('id', blog.id);

    res.json(successResponse('Blog retrieved successfully', {
      ...blog,
      featured_image_url: blog.featured_image_url || '/mainlogo.webp',
      tags: blog.tags || []
    }));
  } catch (error) {
    console.error('Error fetching blog:', error);
    res.status(500).json(errorResponse('Failed to fetch blog', error.message));
  }
};

// Get blog by ID (admin/superadmin only)
const getBlogById = async (req, res) => {
  try {
    const { id } = req.params;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: blog, error } = await supabaseAdmin
      .from('blogs')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json(errorResponse('Blog post not found'));
      }
      throw error;
    }

    res.json(successResponse('Blog retrieved successfully', {
      ...blog,
      tags: blog.tags || []
    }));
  } catch (error) {
    console.error('Error fetching blog:', error);
    res.status(500).json(errorResponse('Failed to fetch blog', error.message));
  }
};

// Create new blog post (admin/superadmin only)
const createBlog = async (req, res) => {
  try {
    const {
      title,
      slug: providedSlug,
      excerpt,
      content,
      structured_content,
      featured_image_url,
      content_images = [],
      author_name,
      status = 'draft',
      tags = [],
      categories = [],
      meta_keywords = [],
      read_time_minutes: incomingReadTime
    } = req.body;

    if (!title || (!content && !structured_content)) {
      return res.status(400).json(errorResponse('Title and content (or structured_content) are required'));
    }

    // Use provided slug or generate from title
    let slug = providedSlug ? generateSlug(providedSlug) : generateSlug(title);
    
    // Check if slug already exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: existingBlog } = await supabaseAdmin
      .from('blogs')
      .select('slug')
      .eq('slug', slug)
      .single();

    // If slug exists, append a number
    if (existingBlog) {
      let counter = 1;
      let newSlug = `${slug}-${counter}`;
      
      while (true) {
        const { data: slugCheck } = await supabaseAdmin
          .from('blogs')
          .select('id')
          .eq('slug', newSlug)
          .maybeSingle();
        if (!slugCheck) break;
        counter++;
        newSlug = `${slug}-${counter}`;
      }
      slug = newSlug;
    }

    const published_at = status === 'published' ? new Date().toISOString() : null;

    let computedReadTime = incomingReadTime;

    // Process structured content if provided (only when non-empty; empty array is valid when content is HTML)
    let processedStructuredContent = null;
    if (structured_content && Array.isArray(structured_content) && structured_content.length > 0) {
      // Validate structured content only when we have blocks
      const validation = validateStructuredContent(structured_content);
      if (!validation.isValid) {
        return res.status(400).json(errorResponse('Invalid structured content', validation.errors));
      }
      
      processedStructuredContent = processContent(structured_content);
      
      // Calculate reading time if not provided
      if (!computedReadTime) {
        computedReadTime = calculateReadingTime(processedStructuredContent);
      }
    }

    // Process content images
    let processedContentImages = [];
    if (content_images && Array.isArray(content_images)) {
      processedContentImages = content_images.filter(img => img && img.src);
    }

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: blog, error } = await supabaseAdmin
      .from('blogs')
      .insert([{
        title,
        slug,
        excerpt,
        content,
        structured_content: processedStructuredContent,
        featured_image_url,
        content_images: processedContentImages,
        author_id: req.user.id,
        author_name: author_name || req.user.name || 'Admin',
        status,
        published_at,
        tags: Array.isArray(tags) ? tags : [],
        categories: Array.isArray(categories) ? categories : [],
        meta_keywords: Array.isArray(meta_keywords) ? meta_keywords : [],
        read_time_minutes: computedReadTime || 5,
        view_count: 0
      }])
      .select('*')
      .single();

    if (error) throw error;

    res.status(201).json(successResponse('Blog created successfully', {
      ...blog,
      tags: blog.tags || [],
      structured_content: blog.structured_content || [],
      content_images: blog.content_images || []
    }));
  } catch (error) {
    console.error('Error creating blog:', error);
    res.status(500).json(errorResponse('Failed to create blog', error.message));
  }
};

// Update blog post (admin/superadmin only)
const updateBlog = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      excerpt,
      content,
      structured_content,
      featured_image_url,
      content_images,
      author_name,
      status,
      tags,
      categories,
      meta_keywords,
      read_time_minutes
    } = req.body;

    // Check if blog exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: existingBlog, error: fetchError } = await supabaseAdmin
      .from('blogs')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json(errorResponse('Blog post not found'));
      }
      throw fetchError;
    }

    let published_at = existingBlog.published_at;

    // Handle status change to published
    if (status === 'published' && existingBlog.status !== 'published') {
      published_at = new Date().toISOString();
    } else if (status !== 'published') {
      published_at = null;
    }

    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (title) {
      updateData.title = title;
      // If title changed and no slug provided, regenerate slug
      if (!slug && title !== existingBlog.title) {
        let newSlug = generateSlug(title);
        // Check if slug already exists (excluding current blog)
        const { data: slugExists } = await supabaseAdmin
          .from('blogs')
          .select('id')
          .eq('slug', newSlug)
          .neq('id', id)
          .maybeSingle();
        
        if (slugExists) {
          let counter = 1;
          let finalSlug = `${newSlug}-${counter}`;
          let checkResult = await supabaseAdmin.from('blogs').select('id').eq('slug', finalSlug).neq('id', id).maybeSingle();
          while (checkResult.data) {
            counter++;
            finalSlug = `${newSlug}-${counter}`;
            checkResult = await supabaseAdmin.from('blogs').select('id').eq('slug', finalSlug).neq('id', id).maybeSingle();
          }
          newSlug = finalSlug;
        }
        updateData.slug = newSlug;
      }
    }
    // Allow manual slug updates
    if (slug !== undefined && slug !== null && slug !== '') {
      const normalizedSlug = generateSlug(slug);
      // Check if slug already exists (excluding current blog)
      const { data: slugExists } = await supabaseAdmin
        .from('blogs')
        .select('id')
        .eq('slug', normalizedSlug)
        .neq('id', id)
        .maybeSingle();
      
      if (slugExists) {
        return res.status(400).json(errorResponse('Slug already exists. Please choose a different one.'));
      }
      updateData.slug = normalizedSlug;
    }
    if (excerpt !== undefined) updateData.excerpt = excerpt;
    if (content) updateData.content = content;
    if (structured_content !== undefined) {
      if (structured_content && Array.isArray(structured_content) && structured_content.length > 0) {
        // Validate structured content only when we have blocks
        const validation = validateStructuredContent(structured_content);
        if (!validation.isValid) {
          return res.status(400).json(errorResponse('Invalid structured content', validation.errors));
        }
        
        updateData.structured_content = processContent(structured_content);
        
        // Recalculate reading time if structured content is updated
        if (!read_time_minutes) {
          updateData.read_time_minutes = calculateReadingTime(updateData.structured_content);
        }
      } else {
        // Empty array or null: allow (e.g. when using HTML content only)
        updateData.structured_content = null;
      }
    }
    if (featured_image_url !== undefined) updateData.featured_image_url = featured_image_url;
    if (content_images !== undefined) {
      updateData.content_images = content_images && Array.isArray(content_images) 
        ? content_images.filter(img => img && img.src)
        : [];
    }
    if (author_name) updateData.author_name = author_name;
    if (status) updateData.status = status;
    if (tags !== undefined) updateData.tags = Array.isArray(tags) ? tags : [];
    if (categories !== undefined) updateData.categories = Array.isArray(categories) ? categories : [];
    if (meta_keywords !== undefined) updateData.meta_keywords = Array.isArray(meta_keywords) ? meta_keywords : [];
    if (read_time_minutes !== undefined) updateData.read_time_minutes = read_time_minutes;
    
    updateData.published_at = published_at;

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: blog, error } = await supabaseAdmin
      .from('blogs')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw error;

    res.json(successResponse('Blog updated successfully', {
      ...blog,
      tags: blog.tags || [],
      structured_content: blog.structured_content || [],
      content_images: blog.content_images || []
    }));
  } catch (error) {
    console.error('Error updating blog:', error);
    res.status(500).json(errorResponse('Failed to update blog', error.message));
  }
};

// Delete blog post (superadmin only)
const deleteBlog = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if blog exists
    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { data: existingBlog, error: fetchError } = await supabaseAdmin
      .from('blogs')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json(errorResponse('Blog post not found'));
      }
      throw fetchError;
    }

    // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
    const { error } = await supabaseAdmin
      .from('blogs')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json(successResponse('Blog deleted successfully'));
  } catch (error) {
    console.error('Error deleting blog:', error);
    res.status(500).json(errorResponse('Failed to delete blog', error.message));
  }
};


module.exports = {
  getAllBlogs,
  getBlogBySlug,
  getBlogById,
  createBlog,
  updateBlog,
  deleteBlog,
};