#!/bin/bash

# Nova Automated Backup Script
# This script commits and pushes any local changes on the VM to GitHub

cd /opt/nova

# Check if there are any changes (modified, deleted, or untracked files)
if [[ -n $(git status --porcelain) ]]; then
    echo "$(date): Changes detected. Starting backup..."
    
    # Add all changes
    git add -A
    
    # Commit with a timestamp and the [skip ci] tag to prevent deployment loops
    git commit -m "Auto backup: $(date "+%Y-%m-%d %H:%M:%S") [skip ci]"
    
    # Push to GitHub
    if git push origin main; then
        echo "$(date): Backup pushed to GitHub successfully."
    else
        echo "$(date): ERROR - Failed to push to GitHub." >&2
        exit 1
    fi
else
    echo "$(date): No changes detected. Nothing to backup."
fi
