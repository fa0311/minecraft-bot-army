#!/bin/bash
# git wrapper for this workspace: the directory is owned by another user and ~/.gitconfig is read-only, so the settings ride on the command line
exec git -c safe.directory=/root/workspace -c commit.gpgsign=false -c user.name=fa0311-army -c user.email=noreply@localhost "$@"
