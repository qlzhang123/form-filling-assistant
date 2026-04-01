export const FIELD_ONTOLOGY = {
    paper: {
        label: '论文信息',
        roles: {
            title: { expectedValueType: 'title_text' },
            doi: { expectedValueType: 'identifier' },
            abstract: { expectedValueType: 'long_text' },
            summary: { expectedValueType: 'summary_text' },
            keywords: { expectedValueType: 'keyword_list' },
            citationCount: { expectedValueType: 'number' },
            language: { expectedValueType: 'language' },
            type: { expectedValueType: 'document_type' },
            presentationType: { expectedValueType: 'presentation_type' },
            funding: { expectedValueType: 'funding_text' },
            url: { expectedValueType: 'url' }
        }
    },
    publication: {
        label: '发表信息',
        roles: {
            venue: { expectedValueType: 'venue_name' },
            venueShort: { expectedValueType: 'short_name' },
            year: { expectedValueType: 'year' },
            date: { expectedValueType: 'date' },
            volume: { expectedValueType: 'number_text' },
            issue: { expectedValueType: 'number_text' },
            volumeIssue: { expectedValueType: 'text' },
            pages: { expectedValueType: 'page_info' },
            articleNumber: { expectedValueType: 'identifier' },
            indexing: { expectedValueType: 'indexing_list' }
        }
    },
    conference: {
        label: '会议信息',
        roles: {
            name: { expectedValueType: 'event_name' },
            shortName: { expectedValueType: 'short_name' },
            location: { expectedValueType: 'place' },
            organizer: { expectedValueType: 'organization_or_person' },
            date: { expectedValueType: 'date' }
        }
    },
    author: {
        label: '作者信息',
        roles: {
            names: { expectedValueType: 'person_list' },
            affiliations: { expectedValueType: 'organization_list' }
        }
    },
    narrative: {
        label: '说明信息',
        roles: {
            summary: { expectedValueType: 'summary_text' },
            description: { expectedValueType: 'long_text' },
            notes: { expectedValueType: 'note_text' }
        }
    }
};
