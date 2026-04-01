export const FIELD_ALIASES = [
    {
        domain: 'paper',
        role: 'title',
        aliases: ['论文标题', '成果标题', '题目', 'title', 'paper title'],
        negatives: ['会议', '地点', '地址', '组织者', '作者']
    },
    {
        domain: 'paper',
        role: 'doi',
        aliases: ['doi']
    },
    {
        domain: 'paper',
        role: 'abstract',
        aliases: ['摘要', 'abstract'],
        negatives: ['摘要精简版', '简介', '概述']
    },
    {
        domain: 'paper',
        role: 'summary',
        aliases: ['成果简介', '内容概述', '简介', '摘要精简版', 'summary', 'brief abstract'],
        negatives: ['标题', 'doi', '备注']
    },
    {
        domain: 'paper',
        role: 'keywords',
        aliases: ['关键词', '关键字', 'keyword', 'keywords']
    },
    {
        domain: 'paper',
        role: 'citationCount',
        aliases: ['引用次数', '被引次数', 'citation', 'citations']
    },
    {
        domain: 'paper',
        role: 'language',
        aliases: ['语言', '语种', 'language']
    },
    {
        domain: 'paper',
        role: 'type',
        aliases: ['成果类型', '成果类别', '成果形式', '文献类型', '标签', 'type', 'category'],
        negatives: ['语言', '日期', '报告', '展示', '论文类别']
    },
    {
        domain: 'paper',
        role: 'presentationType',
        aliases: ['论文类别', '报告类别', '展示类别', '参会类别', 'presentation type', 'report type'],
        negatives: ['成果类型', '语言', '日期']
    },
    {
        domain: 'paper',
        role: 'funding',
        aliases: ['基金标注', '基金资助', '基金项目', '资助项目', 'grant', 'funding'],
        negatives: ['备注', '说明']
    },
    {
        domain: 'paper',
        role: 'url',
        aliases: ['全文链接', '论文链接', '链接', '网址', 'url', 'link']
    },
    {
        domain: 'author',
        role: 'names',
        aliases: ['作者', '作者姓名', 'authors', 'author'],
        negatives: ['单位', '机构', '排名']
    },
    {
        domain: 'author',
        role: 'affiliations',
        aliases: ['作者机构', '作者单位', '工作单位', '单位', '机构', 'affiliation', 'affiliations'],
        negatives: ['作者排名', '姓名']
    },
    {
        domain: 'publication',
        role: 'venue',
        aliases: ['期刊', '刊物', '发表刊物', '成果来源', '来源刊物', '期刊/会议', 'venue', 'journal'],
        negatives: ['简称', '地点', '组织者', '会议名称', '会议题目']
    },
    {
        domain: 'publication',
        role: 'venueShort',
        aliases: ['会议简称', '刊物简称', '简称', 'acronym'],
        negatives: ['名称', '地点', '组织者']
    },
    {
        domain: 'publication',
        role: 'year',
        aliases: ['年份', '年度', 'year'],
        negatives: ['月份', '日期']
    },
    {
        domain: 'publication',
        role: 'date',
        aliases: ['发表日期', '出版日期', 'publication date', 'publish date'],
        negatives: ['会议开始', '会议结束']
    },
    {
        domain: 'publication',
        role: 'volume',
        aliases: ['卷号', 'volume']
    },
    {
        domain: 'publication',
        role: 'issue',
        aliases: ['期号', 'issue']
    },
    {
        domain: 'publication',
        role: 'volumeIssue',
        aliases: ['卷期', '卷/期', 'volume issue']
    },
    {
        domain: 'publication',
        role: 'pages',
        aliases: ['页码', '页码范围', 'page', 'pages'],
        negatives: ['起始页码', '终止页码']
    },
    {
        domain: 'publication',
        role: 'pages',
        aliases: ['起始页码', '首页', '开始页码', 'start page', 'first page'],
        component: 'first'
    },
    {
        domain: 'publication',
        role: 'pages',
        aliases: ['终止页码', '末页', '结束页码', 'end page', 'last page'],
        component: 'last'
    },
    {
        domain: 'publication',
        role: 'articleNumber',
        aliases: ['文章号', '文章编号', 'article number']
    },
    {
        domain: 'publication',
        role: 'indexing',
        aliases: ['收录情况', '收录类型', '收录类别', 'indexing', 'indexed by']
    },
    {
        domain: 'conference',
        role: 'name',
        aliases: ['会议名称', '会议题目', '学术活动名称', 'event name', 'conference title'],
        negatives: ['地点', '地址', '组织者', '主办方', '承办方']
    },
    {
        domain: 'conference',
        role: 'shortName',
        aliases: ['会议简称', 'event short name', 'conference short name'],
        negatives: ['地点', '组织者']
    },
    {
        domain: 'conference',
        role: 'location',
        aliases: ['会议地点', '会议地址', '举办地', '地点', '地址', 'location', 'city'],
        negatives: ['组织者', '主办方', '承办方', '名称', '题目']
    },
    {
        domain: 'conference',
        role: 'organizer',
        aliases: ['会议组织者', '组织者', '主办方', '承办方', 'sponsor', 'organizer', 'chair'],
        negatives: ['地点', '地址', '名称', '题目', '举办地']
    },
    {
        domain: 'conference',
        role: 'date',
        aliases: ['会议举办日期', '会议日期', 'event date', 'conference date'],
        negatives: ['发表日期', '出版日期']
    },
    {
        domain: 'conference',
        role: 'date',
        aliases: ['会议开始日期', '开始日期', 'start date', 'from date'],
        boundary: 'start'
    },
    {
        domain: 'conference',
        role: 'date',
        aliases: ['会议结束日期', '结束日期', 'end date', 'to date', 'until date'],
        boundary: 'end'
    },
    {
        domain: 'narrative',
        role: 'summary',
        aliases: ['成果简介', '内容简介', '概述', 'summary'],
        negatives: ['标题', '日期']
    },
    {
        domain: 'narrative',
        role: 'description',
        aliases: ['详细描述', '说明', 'description'],
        negatives: ['标题', '摘要']
    },
    {
        domain: 'narrative',
        role: 'notes',
        aliases: ['备注', '补充说明', 'note', 'notes'],
        negatives: ['基金', '资助']
    }
];
