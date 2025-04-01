// module contains all the transformations
// from vespa to the user accepted types
import {
  fileSchema,
  mailSchema,
  userSchema,
  MailResponseSchema,
  eventSchema,
  userQuerySchema,
  mailAttachmentSchema,
  MailAttachmentResponseSchema,
} from "../search/types.js"
import {
  AutocompleteEventSchema,
  AutocompleteFileSchema,
  AutocompleteMailAttachmentSchema,
  AutocompleteMailSchema,
  AutocompleteUserQueryHSchema,
  AutocompleteUserSchema,
  EventResponseSchema,
  FileResponseSchema,
  UserResponseSchema,
} from "../shared/types.js"
// Vespa -> Backend/App -> Client
export const VespaSearchResponseToSearchResult = (resp) => {
    const { root } = resp;
    return {
        count: root.fields?.totalCount ?? 0,
        results: root.children
            ? root.children.map((child) => {
                // Narrow down the type based on `sddocname`
                if (child.fields.sddocname === fileSchema) {
                    ;
                    child.fields.type = fileSchema;
                    child.fields.relevance = child.relevance;
                    child.fields.chunks_summary = child.fields.chunks_summary;
                    return FileResponseSchema.parse(child.fields);
                }
                else if (child.fields.sddocname === userSchema) {
                    ;
                    child.fields.type = userSchema;
                    child.fields.relevance = child.relevance;
                    return UserResponseSchema.parse(child.fields);
                }
                else if (child.fields.sddocname === mailSchema) {
                    ;
                    child.fields.type = mailSchema;
                    child.fields.relevance = child.relevance;
                    if (child.fields.chunks_summary) {
                        ;
                        child.fields.chunks_summary = child.fields.chunks_summary;
                    }
                    return MailResponseSchema.parse(child.fields);
                }
                else if (child.fields.sddocname === eventSchema) {
                    ;
                    child.fields.type = eventSchema;
                    child.fields.relevance = child.relevance;
                    if (child.fields.description) {
                        ;
                        child.fields.description = child.fields.description;
                    }
                    return EventResponseSchema.parse(child.fields);
                }
                else if (child.fields.sddocname ===
                    mailAttachmentSchema) {
                    ;
                    child.fields.type = mailAttachmentSchema;
                    child.fields.relevance = child.relevance;
                    return MailAttachmentResponseSchema.parse(child.fields);
                }
                else {
                    throw new Error(`Unknown schema type: ${child.fields?.sddocname}`);
                }
            })
            : [],
    };
};
export const VespaAutocompleteResponseToResult = (resp) => {
    const { root } = resp;
    if (!root.children) {
        return { results: [] };
    }
    let queryHistoryCount = 0;
    return {
        results: root.children
            .map((child) => {
            // Narrow down the type based on `sddocname`
            if (child.fields.sddocname === fileSchema) {
                ;
                child.fields.type = fileSchema;
                child.fields.relevance = child.relevance;
                return AutocompleteFileSchema.parse(child.fields);
            }
            else if (child.fields.sddocname === userSchema) {
                ;
                child.fields.type = userSchema;
                child.fields.relevance = child.relevance;
                return AutocompleteUserSchema.parse(child.fields);
            }
            else if (child.fields.sddocname === mailSchema) {
                ;
                child.fields.type = mailSchema;
                child.fields.relevance = child.relevance;
                return AutocompleteMailSchema.parse(child.fields);
            }
            else if (child.fields.sddocname === eventSchema) {
                ;
                child.fields.type = eventSchema;
                child.fields.relevance = child.relevance;
                return AutocompleteEventSchema.parse(child.fields);
            }
            else if (child.fields.sddocname ===
                userQuerySchema) {
                ;
                child.fields.type = userQuerySchema;
                child.fields.relevance = child.relevance;
                return AutocompleteUserQueryHSchema.parse(child.fields);
            }
            else if (child.fields.sddocname ===
                mailAttachmentSchema) {
                ;
                child.fields.type = mailAttachmentSchema;
                child.fields.relevance = child.relevance;
                return AutocompleteMailAttachmentSchema.parse(child.fields);
            }
            else {
                throw new Error(`Unknown schema type: ${child.fields?.sddocname}`);
            }
        })
            .filter((d) => {
            if (d.type === userQuerySchema) {
                return queryHistoryCount++ < 3;
            }
            return true;
        }),
    };
};
export function handleVespaGroupResponse(response) {
    const appEntityCounts = {};
    // Navigate to the first level of groups
    const groupRoot = response.root.children?.[0]; // Assuming this is the group:root level
    if (!groupRoot || !("children" in groupRoot))
        return appEntityCounts; // Safeguard for empty responses
    // Navigate to the app grouping (e.g., grouplist:app)
    const appGroup = groupRoot.children?.[0];
    if (!appGroup || !("children" in appGroup))
        return appEntityCounts; // Safeguard for missing app group
    // Iterate through the apps
    // @ts-ignore
    for (const app of appGroup.children) {
        const appName = app.value; // Get the app name
        appEntityCounts[appName] = {}; // Initialize the app entry
        // Navigate to the entity grouping (e.g., grouplist:entity)
        const entityGroup = app.children?.[0];
        if (!entityGroup || !("children" in entityGroup))
            continue; // Skip if no entities
        // Iterate through the entities
        // @ts-ignore
        for (const entity of entityGroup.children) {
            const entityName = entity.value; // Get the entity name
            const count = entity.fields?.["count()"] || 0; // Get the count or default to 0
            appEntityCounts[appName][entityName] = count; // Assign the count to the app-entity pair
        }
    }
    return appEntityCounts; // Return the final map
}
