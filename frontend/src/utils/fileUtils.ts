import { isValidFile } from "../../../shared/filesutils"
import { SelectedFile } from "@/components/KbFileUpload"

// Generate unique ID for files
export const generateFileId = () => Math.random().toString(36).substring(2, 9)

// Check if file is an image
const isImageFile = (file: File): boolean => {
  return (
    file.type.startsWith("image/") &&
    [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ].includes(file.type)
  )
}

// Create preview URL for image files
export const createImagePreview = (file: File): string | undefined => {
  if (isImageFile(file)) {
    return URL.createObjectURL(file)
  }
  return undefined
}

// Clean up preview URLs to prevent memory leaks
export const cleanupPreviewUrls = (previews: string[]) => {
  previews.forEach((url) => {
    if (url) {
      URL.revokeObjectURL(url)
    }
  })
}

// Common drag and drop handlers
export const createDragHandlers = () => {
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
  }

  return { handleDragOver, handleDragLeave }
}

// Common file selection handlers
export const createFileSelectionHandlers = (
  fileInputRef: React.RefObject<HTMLInputElement>,
  processFiles: (files: FileList | File[]) => void,
) => {
  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      processFiles(files)
    }
    // Reset the input value so the same file can be selected again
    e.target.value = ""
  }

  return { handleFileSelect, handleFileChange }
}

// Common file validation and deduplication logic
export const validateAndDeduplicateFiles = (
  files: FileList | File[],
  showToast: (title: string, description: string, isError?: boolean) => void,
) => {
  const fileArray = Array.from(files).filter(
    (file) => !file.name.startsWith("."),
  )

  const validFiles = fileArray.filter(isValidFile)
  const invalidFiles = fileArray.length - validFiles.length

  if (invalidFiles > 0) {
    showToast(
      "Invalid file(s)",
      `${invalidFiles} file(s) ignored. Files must be under 40MB, images under 5MB and of supported types.`,
      true,
    )
  }

  if (validFiles.length === 0) return []

  // Create a map to track files by name for deduplication
  const fileMap = new Map<string, File>()
  let duplicateCount = 0

  // Keep only the first occurrence of each filename
  validFiles.forEach((file) => {
    if (!fileMap.has(file.name)) {
      fileMap.set(file.name, file)
    } else {
      duplicateCount++
    }
  })

  // Notify about duplicates if any were found
  if (duplicateCount > 0) {
    showToast(
      "Duplicate files",
      `${duplicateCount} duplicate file(s) were ignored.`,
      false,
    )
  }

  return Array.from(fileMap.values())
}

// Common toast notification creator
export const createToastNotifier = (
  toast: (options: {
    title: string
    description: string
    variant?: "default" | "destructive"
    duration?: number
  }) => void,
) => {
  return (title: string, description: string, isError = false) => {
    toast({
      title,
      description,
      variant: isError ? "destructive" : "default",
      duration: 2000,
    })
  }
}

// build file tree
export interface FileNode {
  name: string;
  type: 'folder' | 'file';
  children?: FileNode[];
  files?: number;
  lastUpdated?: string;
  updatedBy?: string;
  isOpen?: boolean;
}

export const buildFileTree = (files: { name: string, type: 'file' | 'folder', totalCount?: number, updatedAt?: string }[]): FileNode[] => {
  const root: FileNode = { name: 'root', type: 'folder', children: [], files: 0, lastUpdated: '', updatedBy: '' };

  for (const file of files) {
    const parts = file.name.split('/');
    let currentNode = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      let childNode = currentNode.children?.find(child => child.name === part);

      if (!childNode) {
        childNode = {
          name: part,
          type: isFile ? file.type : 'folder',
          children: isFile ? undefined : [],
          files: file.totalCount,
          lastUpdated: file.updatedAt,
          updatedBy: "rahim.h@rbi.gov.in",
        };
        if (!currentNode.children) {
            currentNode.children = [];
        }
        currentNode.children.push(childNode);
        currentNode.children.sort((a, b) => {
            if (a.type === 'folder' && b.type === 'file') return -1;
            if (a.type === 'file' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name);
        });
      }
      
      if (childNode.type === 'folder') {
        currentNode = childNode;
      }
    }
  }

  return root.children || [];
};

// Collection management functions
export const saveFilesToTempFolder = async (files: SelectedFile[], collectionName: string): Promise<void> => {
  try {
    // Create FormData to send files to backend
    const formData = new FormData();
    formData.append('collectionName', collectionName);
    
    // Add all files to FormData with the same key name
    files.forEach((selectedFile) => {
      formData.append('files', selectedFile.file);
    });
    
    console.log(`Saving collection "${collectionName}" with ${files.length} files to backend kbtemp folder`);
    
    // Send files to backend API
    const response = await fetch('/api/v1/collections/temp/upload', {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Upload successful:', result);
    
    return Promise.resolve();
  } catch (error) {
    console.error('Failed to save files to temp folder:', error);
    throw error;
  }
};

export const removeCollectionFromTempFolder = async (collectionName: string): Promise<void> => {
  try {
    console.log(`Removing collection "${collectionName}" from temp folder`);
    
    // Send delete request to backend API
    const response = await fetch(`/api/v1/collections/temp/${encodeURIComponent(collectionName)}`, {
      method: 'DELETE',
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Delete failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log(`Successfully removed collection "${collectionName}":`, result);
    return Promise.resolve();
  } catch (error) {
    console.error('Failed to remove collection from temp folder:', error);
    throw error;
  }
};

export const removeFileFromTempFolder = async (collectionName: string, filePath: string): Promise<void> => {
  try {
    console.log(`Removing file "${filePath}" from collection "${collectionName}"`);
    
    const response = await fetch(`/api/v1/collections/temp/delete-file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ collectionName, filePath }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Delete failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    console.log(`Successfully removed file "${filePath}":`, result);
    return Promise.resolve();
  } catch (error) {
    console.error('Failed to remove file from temp folder:', error);
    throw error;
  }
};

export const addFilesToExistingCollection = async (files: SelectedFile[], collectionName: string): Promise<void> => {
  try {
    console.log(`Adding ${files.length} files to existing collection "${collectionName}"`);
    
    // Create FormData to send files to backend
    const formData = new FormData();
    formData.append('collectionName', collectionName);
    
    // Add all files to FormData
    files.forEach((selectedFile, index) => {
      formData.append(`files`, selectedFile.file);
    });
    
    // Send files to backend API
    const response = await fetch('/api/v1/collections/temp/add-files', {
      method: 'POST',
      body: formData,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Add files failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Add files successful:', result);
    
    return Promise.resolve();
  } catch (error) {
    console.error('Failed to add files to collection:', error);
    throw error;
  }
};

export const uploadFileBatch = async (files: File[], collectionName: string): Promise<void> => {
  const formData = new FormData();
  formData.append('collectionName', collectionName);
  files.forEach(file => {
    formData.append('files', file, (file as any).webkitRelativePath || file.name);
  });

  const response = await fetch('/api/v1/collections/batch-upload', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Batch upload failed: ${response.status} ${response.statusText} - ${errorText}`);
  }
};
